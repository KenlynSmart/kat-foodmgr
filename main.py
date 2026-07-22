import asyncio
import calendar
import os
import re
import secrets
from contextvars import ContextVar
from pathlib import Path
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from typing import Literal
from uuid import UUID

import jwt
import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from supabase import Client, create_client


app = FastAPI(
    title="VN Food Cloud v2.0 API Gateway",
    description="Backend phục vụ xử lý nghiệp vụ đi chợ, quản lý tồn kho và đồng bộ Supabase",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8008",
        "http://127.0.0.1:8008",
        "https://kenlynsmart.github.io",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://flqwtnxyclvyepvvxpfs.supabase.co"
)
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_KEY",
    "sb_publishable_3g8a4d68v1XWEs86b-zckg_00OAZmMt",
)
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
AUTH_JWT_SECRET = os.environ.get("AUTH_JWT_SECRET") or secrets.token_urlsafe(32)
AUTH_JWT_ALGORITHM = "HS256"
AUTH_JWT_EXPIRE_MINUTES = int(os.environ.get("AUTH_JWT_EXPIRE_MINUTES", "720"))
GOOGLE_OAUTH_REDIRECT_URI = os.environ.get(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "https://kat-foodmgr-backend.onrender.com/api/auth/google/callback",
)
FRONTEND_URL = os.environ.get("FRONTEND_URL", "/")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
BULK_CHUNK_SIZE = 100
AUTH_CONTEXT: ContextVar[Optional[Dict[str, Any]]] = ContextVar("auth_context", default=None)
ROLE_RANK = {"report-viewer": 1, "staff": 2, "manager": 3, "owner": 4, "admin": 5}

try:
    supabase_read: Optional[Client] = (
        create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY)
        if (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY)
        else None
    )
except Exception as exc:
    print(f"[CẢNH BÁO] Không thể khởi tạo Supabase client đọc: {exc}")
    supabase_read = None

try:
    supabase_write: Optional[Client] = (
        create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        if SUPABASE_SERVICE_ROLE_KEY
        else None
    )
except Exception as exc:
    print(f"[CẢNH BÁO] Không thể khởi tạo Supabase client ghi: {exc}")
    supabase_write = None


def require_write_client() -> Client:
    if not supabase_write:
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình cho backend.",
        )
    return supabase_write


def require_read_client() -> Client:
    if not supabase_read:
        raise HTTPException(
            status_code=503,
            detail="Supabase read client chưa được cấu hình.",
        )
    return supabase_read


def _auth_context() -> Dict[str, Any]:
    user = AUTH_CONTEXT.get()
    if not user:
        return {}
    return user


def _is_system_admin(user: Optional[Dict[str, Any]] = None) -> bool:
    return (user or _auth_context()).get("role") == "admin"


def _vendor_id(user: Optional[Dict[str, Any]] = None) -> Optional[str]:
    context = user or _auth_context()
    if _is_system_admin(context):
        return None
    vendor_id = context.get("vendor_id")
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Tài khoản chưa được gán vendor.")
    system_vendor = (
        require_read_client()
        .table("vendors")
        .select("id")
        .eq("id", str(vendor_id))
        .eq("code", "system")
        .limit(1)
        .execute()
    ).data
    if system_vendor:
        raise HTTPException(status_code=403, detail="Tài khoản system không được truy cập dữ liệu vận hành vendor.")
    return str(vendor_id)


def _scope_query(query: Any, user: Optional[Dict[str, Any]] = None) -> Any:
    vendor_id = _vendor_id(user)
    return query if vendor_id is None else query.eq("vendor_id", vendor_id)


def _scope_payload(payload: Dict[str, Any], user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    vendor_id = _vendor_id(user)
    if vendor_id is not None:
        payload["vendor_id"] = vendor_id
    return payload


def _add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    return value.replace(year=year, month=month, day=min(value.day, calendar.monthrange(year, month)[1]))


def _subscription_fields(vendor_id: Optional[str]) -> Dict[str, Any]:
    if not vendor_id:
        return {"subscription_due_date": None, "subscription_status": None}
    response = (
        require_read_client()
        .table("vendors")
        .select("subscription_due_date,subscription_status")
        .eq("id", str(vendor_id))
        .limit(1)
        .execute()
    )
    fields = response.data[0] if response.data else {"subscription_due_date": None, "subscription_status": None}
    due_date = fields.get("subscription_due_date")
    if due_date and date.fromisoformat(str(due_date)) < date.today():
        fields["subscription_status"] = "expired"
    return fields


def _new_subscription_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    parts = ["".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(5)]
    return "VNFS-" + "-".join(parts)


def _chunks(items: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    return [
        items[index:index + BULK_CHUNK_SIZE]
        for index in range(0, len(items), BULK_CHUNK_SIZE)
    ]


def _run_upsert_chunk(
    client: Client,
    table: str,
    payload: List[Dict[str, Any]],
    conflict_column: str,
) -> List[Dict[str, Any]]:
    payload = [_scope_payload(dict(item)) for item in payload]
    response = client.table(table).upsert(payload, on_conflict=conflict_column).execute()
    return response.data or []


class LoginSchema(BaseModel):
    username: str
    password: str


class ProfileUpdateSchema(BaseModel):
    nickname: Optional[str] = Field(default=None, max_length=100)


class ChangePasswordSchema(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class CreateVendorUserSchema(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    nickname: Optional[str] = Field(default=None, max_length=100)
    role: str = Field(default="staff")
    vendor_id: Optional[UUID] = None


class VendorSchema(BaseModel):
    code: str = Field(..., min_length=2, max_length=50)
    name: str = Field(..., min_length=2, max_length=150)
    status: str = Field(default="active")
    company_full_name: Optional[str] = Field(
        default="CHI NHÁNH CÔNG TY CP VN FOOD - NEP MART", max_length=250
    )
    address: Optional[str] = Field(
        default="Lô 23-24 khu B2-87, KĐT ven sông Hòa Quý - Đồng Nò, Hòa Quý, Ngũ Hành Sơn, Đà Nẵng",
        max_length=500,
    )
    hotline: Optional[str] = Field(default="085.728.0282", max_length=50)
    tax_code: Optional[str] = Field(default=None, max_length=50)
    default_creator_name: Optional[str] = Field(default="Thủ kho VNFS", max_length=150)
    print_show_price_default: bool = True


class VendorRecord(VendorSchema):
    id: UUID
    created_at: datetime
    subscription_due_date: Optional[date] = None
    subscription_status: Optional[str] = None


class VendorProfileUpdateSchema(BaseModel):
    company_full_name: Optional[str] = Field(default=None, max_length=250)
    address: Optional[str] = Field(default=None, max_length=500)
    hotline: Optional[str] = Field(default=None, max_length=50)
    tax_code: Optional[str] = Field(default=None, max_length=50)
    default_creator_name: Optional[str] = Field(default=None, max_length=150)
    print_show_price_default: bool = True


class AssignVendorUserSchema(BaseModel):
    vendor_id: UUID
    role: str
    status: str = "active"


class AuthUser(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    email: Optional[str] = None
    provider: str
    role: str
    status: str
    temp_pin: Optional[str] = None
    vendor_id: Optional[UUID] = None
    vendor_name: Optional[str] = None
    subscription_due_date: Optional[date] = None
    subscription_status: Optional[str] = None
    must_change_password: bool = False


class SubscriptionCodeCreateSchema(BaseModel):
    duration_months: int = Field(default=1, ge=1, le=120)
    price_allocated: float = Field(default=0, ge=0)


class SubscriptionCodeRecord(SubscriptionCodeCreateSchema):
    id: UUID
    code: str
    is_used: bool
    used_by_vendor_id: Optional[UUID] = None
    used_at: Optional[datetime] = None
    created_at: datetime


class RedeemCodeSchema(BaseModel):
    code: str = Field(..., min_length=10, max_length=40)


class AuthResponse(BaseModel):
    status: str = "success"
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str
    user: AuthUser
    must_change_password: bool = False


class GoogleSheetConfigCreateSchema(BaseModel):
    school_id: Optional[UUID] = None
    sheet_name: str = Field(..., min_length=1, max_length=150)
    sheet_url: str = Field(..., min_length=1, max_length=500)
    sheet_id: Optional[str] = Field(default=None, max_length=200)
    sync_direction: Literal["two_way", "push_to_sheet", "pull_from_sheet"] = "two_way"
    auto_sync_enabled: bool = True


class GoogleSheetConfigRecord(GoogleSheetConfigCreateSchema):
    id: UUID
    vendor_id: UUID
    webhook_token: str
    last_synced_at: Optional[datetime] = None
    status: str
    created_at: datetime


class GoogleSheetWebhookSchema(BaseModel):
    config_id: UUID
    token: str
    entity: Literal["catalog", "orders"] = "catalog"
    delivery_date: Optional[date] = None
    records: List[Dict[str, Any]] = Field(default_factory=list)


class GoogleSheetManualTriggerSchema(BaseModel):
    config_id: UUID
    delivery_date: Optional[date] = None


def _create_app_token(user: Dict[str, Any]) -> str:
    now = datetime.utcnow()
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "vendor_id": str(user["vendor_id"]) if user.get("vendor_id") else None,
        "must_change_password": bool(user.get("must_change_password", False)),
        "iat": now,
        "exp": now.timestamp() + AUTH_JWT_EXPIRE_MINUTES * 60,
    }
    return jwt.encode(payload, AUTH_JWT_SECRET, algorithm=AUTH_JWT_ALGORITHM)


def _auth_user_from_row(row: Dict[str, Any]) -> AuthUser:
    return AuthUser(
        id=UUID(str(row["id"])),
        username=str(row["username"]),
        nickname=row.get("nickname"),
        email=row.get("email"),
        provider=str(row["provider"]),
        role=str(row["role"]),
        status=str(row["status"]),
        temp_pin=row.get("temp_pin"),
        vendor_id=UUID(str(row["vendor_id"])) if row.get("vendor_id") else None,
        vendor_name=row.get("vendor_name"),
        subscription_due_date=row.get("subscription_due_date"),
        subscription_status=row.get("subscription_status"),
        must_change_password=bool(row.get("must_change_password", False)),
    )


def _vendor_name_for_id(vendor_id: Optional[str]) -> Optional[str]:
    if not vendor_id:
        return None
    response = (
        require_read_client()
        .table("vendors")
        .select("name")
        .eq("id", str(vendor_id))
        .limit(1)
        .execute()
    )
    return str(response.data[0]["name"]) if response.data else None


def require_bearer_user(request: Request) -> Dict[str, Any]:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Thiếu token xác thực.")
    try:
        return jwt.decode(token, AUTH_JWT_SECRET, algorithms=[AUTH_JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Token xác thực không hợp lệ.") from exc


def require_admin_user(user: Dict[str, Any] = Depends(require_bearer_user)) -> Dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Chỉ quản trị viên mới có quyền này.")
    return user


def require_management_user(user: Dict[str, Any] = Depends(require_bearer_user)) -> Dict[str, Any]:
    if ROLE_RANK.get(user.get("role", ""), 0) < ROLE_RANK["manager"]:
        raise HTTPException(status_code=403, detail="Chỉ owner, manager hoặc admin mới có quyền quản lý tài khoản.")
    return user


PUBLIC_API_PATHS = {
    "/api/auth/login",
    "/api/auth/google/url",
    "/api/auth/google/callback",
    "/api/sync/google-sheets/webhook",
}

OPERATIONAL_API_PREFIXES = (
    "/api/products",
    "/api/categories",
    "/api/schools",
    "/api/stock",
    "/api/orders",
)


@app.middleware("http")
async def protect_api_routes(request: Request, call_next):
    if (
        request.method == "OPTIONS"
        or not request.url.path.startswith("/api/")
        or request.url.path in PUBLIC_API_PATHS
        or request.url.path.startswith("/api/sync/google-sheets/payload/")
    ):
        return await call_next(request)

    try:
        user = require_bearer_user(request)
        token = AUTH_CONTEXT.set(user)
        try:
            role = user.get("role", "staff")
            mutation = request.method in {"POST", "PUT", "PATCH", "DELETE"}
            if role == "admin" and request.url.path.startswith(OPERATIONAL_API_PREFIXES):
                if request.method == "GET":
                    return JSONResponse(content=[])
                return JSONResponse(status_code=403, content={"detail": "Admin chỉ quản lý hệ thống, không thao tác dữ liệu vendor."})
            catalog_mutation = any(
                request.url.path.startswith(path)
                for path in ("/api/products", "/api/categories", "/api/schools", "/api/auth/users")
            )
            personal_auth_mutation = request.url.path in {"/api/auth/profile", "/api/auth/change-password"}
            if mutation and role == "report-viewer" and not personal_auth_mutation:
                return JSONResponse(status_code=403, content={"detail": "Tài khoản chỉ có quyền xem báo cáo."})
            if mutation and catalog_mutation and role not in {"admin", "owner", "manager"}:
                return JSONResponse(status_code=403, content={"detail": "Vai trò hiện tại không được sửa danh mục."})
            return await call_next(request)
        finally:
            AUTH_CONTEXT.reset(token)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


class SchoolSchema(BaseModel):
    code: str = Field(..., description="Mã viết tắt của điểm trường (Ví dụ: mitsuba)")
    name: str = Field(..., description="Tên đầy đủ của trường mầm non")
    bg_color: str = Field("bg-sky-50", description="Màu nền Tailwind đại diện")
    text_color: str = Field("text-sky-850", description="Màu chữ Tailwind đại diện")
    border_color: str = Field("border-sky-200", description="Màu viền Tailwind")
    icon: str = Field("fa-school", description="Icon FontAwesome hiển thị")
    school_code: Optional[str] = Field(default=None, max_length=50)
    full_name: Optional[str] = Field(default=None, max_length=250)
    address: Optional[str] = Field(default=None, max_length=500)
    contact_phone: Optional[str] = Field(default=None, max_length=50)
    default_receiver_name: Optional[str] = Field(default=None, max_length=150)
    has_teacher_order: bool = True


class ProductSchema(BaseModel):
    code: str = Field(..., description="Mã viết tắt viết thường của sản phẩm (Ví dụ: cl, tv)")
    name: str = Field(..., description="Tên thực phẩm quy chuẩn")
    unit: str = Field(..., description="Đơn vị tính (Kg, Bó, Gói...)")
    price: float = Field(..., description="Đơn giá gốc cung cấp")
    category_id: Optional[UUID] = Field(None, description="UUID nhóm hàng")


class CategorySchema(BaseModel):
    name: str = Field(..., min_length=1, description="Tên nhóm hàng")


class CategorySchemaWithId(CategorySchema):
    id: UUID


class ProductSchemaWithId(ProductSchema):
    id: UUID


class StockSchema(BaseModel):
    product_id: Optional[UUID] = Field(None, description="UUID của thực phẩm cần điều chỉnh")
    product_code: Optional[str] = Field(
        default=None, description="Mã thực phẩm để tương thích ngược"
    )
    qty: float = Field(..., description="Số lượng tồn kho khả dụng hiện tại")


class OrderBatchSchema(BaseModel):
    id: Optional[UUID] = None
    daily_order_id: UUID
    qty_change: float
    note: str = ""


class OrderUpsertSchema(BaseModel):
    delivery_date: date = Field(..., description="Ngày giao nhận hàng (YYYY-MM-DD)")
    product_id: Optional[UUID] = Field(None, description="UUID mặt hàng phân bổ")
    school_id: Optional[UUID] = Field(None, description="UUID trường nhận hàng")
    product_code: Optional[str] = Field(
        default=None, description="Mã sản phẩm để tương thích ngược"
    )
    school_code: Optional[str] = Field(
        default=None, description="Mã trường để tương thích ngược"
    )
    qty: float = Field(..., description="Số lượng thực tế phân phối")
    batches: List[OrderBatchSchema] = Field(default_factory=list)


class SchoolRecord(SchoolSchema):
    id: UUID
    created_at: datetime


class ProductRecord(ProductSchema):
    id: UUID
    created_at: datetime


class CategoryRecord(CategorySchema):
    id: UUID
    created_at: datetime


class StockRecord(BaseModel):
    id: UUID
    product_id: UUID
    qty: float
    updated_at: datetime


class DailyOrderRecord(BaseModel):
    id: UUID
    delivery_date: date
    product_id: UUID
    school_id: UUID
    qty: float
    created_at: datetime
    batches: List[OrderBatchSchema] = Field(default_factory=list)


def _code(value: str) -> str:
    return value.strip().lower()


def _school_select() -> str:
    return (
        "id,code,name,bg_color,text_color,border_color,icon,school_code,full_name,"
        "address,contact_phone,default_receiver_name,has_teacher_order,created_at"
    )


def _product_select() -> str:
    return "id,code,name,unit,price,category_id,created_at"


def _stock_select() -> str:
    return "id,product_id,qty,updated_at"


def _order_select() -> str:
    return "id,delivery_date,product_id,school_id,qty,created_at"


def _order_batch_select() -> str:
    return "id,daily_order_id,qty_change,note,created_at"


def _attach_order_batches(orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not orders:
        return orders
    order_ids = [str(order["id"]) for order in orders]
    response = _scope_query(
        require_read_client().table("daily_order_batches").select(_order_batch_select())
    ).in_("daily_order_id", order_ids).order("created_at").execute()
    batches_by_order: Dict[str, List[Dict[str, Any]]] = {}
    for batch in response.data or []:
        batches_by_order.setdefault(str(batch["daily_order_id"]), []).append({
            "id": batch["id"],
            "daily_order_id": batch["daily_order_id"],
            "qty_change": batch["qty_change"],
            "note": batch.get("note") or "",
        })
    for order in orders:
        order["batches"] = batches_by_order.get(str(order["id"]), [])
    return orders


def _school_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    data = dict(payload)
    code = data.pop("code", data.pop("id", ""))
    data["code"] = _code(str(code))
    return _scope_payload(data)


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except Exception:
        return False


def _lookup_id_by_code(table: str, code_field: str, code: str) -> Optional[str]:
    response = (
        _scope_query(require_read_client().table(table).select("id"))
        .eq(code_field, _code(code))
        .limit(1)
        .execute()
    )
    if response.data:
        return str(response.data[0]["id"])
    return None


def _normalise_order_payload(item: Dict[str, Any]) -> Dict[str, Any]:
    data = dict(item)
    batches = data.pop("batches", []) or []
    if not data.get("product_id") and data.get("product_code"):
        data["product_id"] = _lookup_id_by_code("products", "code", data["product_code"])
    if not data.get("school_id") and data.get("school_code"):
        data["school_id"] = _lookup_id_by_code("schools", "code", data["school_code"])
    data.pop("product_code", None)
    data.pop("school_code", None)
    if not data.get("product_id") or not data.get("school_id"):
        raise HTTPException(status_code=400, detail="Thiếu product_id hoặc school_id cho daily_orders.")
    if not batches and data["qty"] > 0:
        batches = [{"qty_change": data["qty"], "note": "Đợt sáng mặc định"}]
    data["batches"] = batches
    return data


def _sync_order_batches(client: Client, daily_order_id: str, batches: List[Dict[str, Any]]) -> None:
    _scope_query(client.table("daily_order_batches").delete()).eq(
        "daily_order_id", daily_order_id
    ).execute()
    vendor_id = _vendor_id()
    payload = [
        {
            **({"id": batch["id"]} if batch.get("id") else {}),
            "daily_order_id": daily_order_id,
            "qty_change": batch["qty_change"],
            "note": str(batch.get("note") or "").strip(),
            **({"vendor_id": vendor_id} if vendor_id else {}),
        }
        for batch in batches
        if batch["qty_change"] != 0
    ]
    if payload:
        client.table("daily_order_batches").insert(payload).execute()


def _process_order_chunk(
    client: Client,
    raw_items: List[Dict[str, Any]],
) -> Dict[str, int]:
    upsert_payload: List[Dict[str, Any]] = []
    delete_payload: List[Dict[str, Any]] = []
    for item in raw_items:
        normalised = _normalise_order_payload(item)
        (delete_payload if normalised["qty"] <= 0 and not normalised["batches"] else upsert_payload).append(normalised)

    upserted_count = 0
    if upsert_payload:
        response = client.table("daily_orders").upsert(
            [
                _scope_payload({key: value for key, value in item.items() if key != "batches"})
                for item in upsert_payload
            ],
            on_conflict="vendor_id,delivery_date,product_id,school_id",
        ).execute()
        parents = response.data or []
        upserted_count = len(parents)
        parents_by_key = {
            (
                str(parent["delivery_date"]),
                str(parent["product_id"]),
                str(parent["school_id"]),
            ): parent
            for parent in parents
        }
        for item in upsert_payload:
            key = (item["delivery_date"], str(item["product_id"]), str(item["school_id"]))
            _sync_order_batches(client, str(parents_by_key[key]["id"]), item["batches"])

    deleted_count = 0
    for item in delete_payload:
        _scope_query(client.table("daily_orders").delete()) \
            .eq("delivery_date", item["delivery_date"]) \
            .eq("product_id", item["product_id"]) \
            .eq("school_id", item["school_id"]) \
            .execute()
        deleted_count += 1

    return {"upserted_count": upserted_count, "deleted_count": deleted_count}


@app.post("/api/auth/login", response_model=AuthResponse)
async def login(credentials: LoginSchema):
    try:
        response = (
            require_read_client()
            .table("users")
            .select("id,username,nickname,password,temp_pin,vendor_id,email,provider,role,status")
            .eq("username", credentials.username.strip())
            .eq("provider", "local")
            .limit(1)
            .execute()
        )
        user = response.data[0] if response.data else None
        password_matches = bool(
            user
            and user.get("password")
            and pwd_context.verify(credentials.password, user["password"])
        )
        pin_matches = bool(user and user.get("temp_pin") and credentials.password == user["temp_pin"])
        if not password_matches and not pin_matches:
            raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng.")
        if user["status"] != "active":
            raise HTTPException(status_code=403, detail="Tài khoản đã bị khóa.")
        user["must_change_password"] = pin_matches
        user["vendor_name"] = _vendor_name_for_id(user.get("vendor_id"))
        user.update(_subscription_fields(user.get("vendor_id")))
        return AuthResponse(
            access_token=_create_app_token(user),
            role=user["role"],
            username=user["username"],
            user=_auth_user_from_row(user),
            must_change_password=pin_matches,
        )
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[CẢNH BÁO] Login backend error: {exc}")
        raise HTTPException(status_code=503, detail="Dịch vụ xác thực chưa sẵn sàng.") from exc


@app.get("/api/auth/google/url")
async def google_login_url():
    try:
        response = require_read_client().auth.sign_in_with_oauth(
            {
                "provider": "google",
                "options": {"redirect_to": GOOGLE_OAUTH_REDIRECT_URI},
            }
        )
        return {"url": response.url}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[CẢNH BÁO] Google OAuth URL error: {exc}")
        raise HTTPException(status_code=503, detail="Google OAuth chưa được cấu hình.") from exc


@app.get("/api/auth/google/callback")
async def google_callback(
    code: Optional[str] = Query(default=None),
    access_token: Optional[str] = Query(default=None),
):
    try:
        auth_user = None
        if code:
            auth_response = require_read_client().auth.exchange_code_for_session(
                {"auth_code": code}
            )
            auth_user = auth_response.user
        elif access_token:
            auth_response = require_read_client().auth.get_user(access_token)
            auth_user = auth_response.user if auth_response else None
        if not auth_user or not auth_user.email:
            raise HTTPException(status_code=400, detail="Không nhận được email Google hợp lệ.")

        email = auth_user.email.strip().lower()
        client = require_write_client()
        existing = (
            client.table("users")
            .select("id,username,nickname,password,email,provider,role,status")
            .eq("email", email)
            .limit(1)
            .execute()
        )
        user = existing.data[0] if existing.data else None
        if not user:
            created = (
                client.table("users")
                .insert(
                    {
                        "username": email,
                        "email": email,
                        "provider": "google",
                        "role": "staff",
                        "status": "active",
                    }
                )
                .execute()
            )
            user = created.data[0] if created.data else None
        if not user or user["status"] != "active":
            raise HTTPException(status_code=403, detail="Tài khoản Google chưa được kích hoạt.")

        token = _create_app_token(user)
        separator = "&" if "?" in FRONTEND_URL else "?"
        redirect_url = f"{FRONTEND_URL}{separator}auth_token={token}"
        return RedirectResponse(url=redirect_url, status_code=302)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[CẢNH BÁO] Google OAuth callback error: {exc}")
        raise HTTPException(status_code=503, detail="Google OAuth callback chưa sẵn sàng.") from exc


@app.get("/api/auth/me", response_model=AuthUser)
async def current_user(user: Dict[str, Any] = Depends(require_bearer_user)):
    try:
        response = (
            require_read_client()
            .table("users")
            .select("id,username,nickname,email,provider,role,status,vendor_id")
            .eq("id", user["sub"])
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=401, detail="Tài khoản không còn tồn tại.")
        record = response.data[0]
        record["must_change_password"] = bool(user.get("must_change_password", False))
        record["vendor_name"] = _vendor_name_for_id(record.get("vendor_id"))
        record.update(_subscription_fields(record.get("vendor_id")))
        return _auth_user_from_row(record)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải tài khoản: {exc}") from exc


@app.get("/api/auth/users", response_model=List[AuthUser])
async def list_users(
    vendor_id: Optional[UUID] = Query(default=None),
    user: Dict[str, Any] = Depends(require_management_user),
):
    try:
        select_fields = "id,username,nickname,email,provider,role,status,vendor_id"
        if _is_system_admin(user):
            select_fields = "id,username,nickname,email,provider,role,status,temp_pin,vendor_id"
        query = require_read_client().table("users").select(
            select_fields
        )
        if _is_system_admin(user):
            if vendor_id:
                query = query.eq("vendor_id", str(vendor_id))
        else:
            query = _scope_query(query, user)
        response = query.order("created_at").execute()
        rows = response.data or []
        vendor_rows = (
            require_read_client()
            .table("vendors")
            .select("id,name")
            .execute()
        ).data or []
        vendor_names = {str(row["id"]): row["name"] for row in vendor_rows}
        for row in rows:
            row["vendor_name"] = vendor_names.get(str(row["vendor_id"])) if row.get("vendor_id") else None
        return [_auth_user_from_row(row) for row in rows]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải danh sách tài khoản: {exc}") from exc


@app.get("/api/vendors", response_model=List[VendorRecord])
async def list_vendors(_: Dict[str, Any] = Depends(require_admin_user)):
    try:
        response = (
            require_read_client()
            .table("vendors")
            .select(
                "id,code,name,status,company_full_name,address,hotline,tax_code,"
                "default_creator_name,print_show_price_default,created_at,"
                "subscription_due_date,subscription_status"
            )
            .order("name")
            .execute()
        )
        return response.data or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải danh sách vendor: {exc}") from exc


@app.get("/api/vendor/profile", response_model=VendorRecord)
async def get_vendor_profile(user: Dict[str, Any] = Depends(require_bearer_user)):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Tài khoản không có vendor vận hành.")
    try:
        response = (
            require_read_client()
            .table("vendors")
            .select(
                "id,code,name,status,company_full_name,address,hotline,tax_code,"
                "default_creator_name,print_show_price_default,created_at,"
                "subscription_due_date,subscription_status"
            )
            .eq("id", vendor_id)
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy vendor hiện tại.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải hồ sơ vendor: {exc}") from exc


@app.put("/api/vendor/profile", response_model=VendorRecord)
async def update_vendor_profile(
    payload: VendorProfileUpdateSchema,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Tài khoản không có vendor vận hành.")
    record = payload.model_dump()
    for field in ("company_full_name", "address", "hotline", "tax_code", "default_creator_name"):
        if record[field] is not None:
            record[field] = record[field].strip() or None
    try:
        response = (
            require_write_client()
            .table("vendors")
            .update(record)
            .eq("id", vendor_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy vendor hiện tại.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể cập nhật hồ sơ vendor: {exc}") from exc


@app.get("/api/admin/subscription-codes", response_model=List[SubscriptionCodeRecord])
async def list_subscription_codes(_: Dict[str, Any] = Depends(require_admin_user)):
    try:
        response = (
            require_read_client()
            .table("subscription_codes")
            .select("id,code,duration_months,price_allocated,is_used,used_by_vendor_id,used_at,created_at")
            .order("created_at", desc=True)
            .execute()
        )
        return response.data or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải mã gia hạn: {exc}") from exc


@app.post("/api/admin/subscription-codes", response_model=SubscriptionCodeRecord)
async def create_subscription_code(
    payload: SubscriptionCodeCreateSchema,
    _: Dict[str, Any] = Depends(require_admin_user),
):
    record = {
        "code": _new_subscription_code(),
        "duration_months": payload.duration_months,
        "price_allocated": payload.price_allocated,
    }
    try:
        response = require_write_client().table("subscription_codes").insert(record).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Không thể tạo mã gia hạn.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tạo mã gia hạn: {exc}") from exc


@app.get("/api/admin/subscription-metrics")
async def subscription_metrics(_: Dict[str, Any] = Depends(require_admin_user)):
    try:
        codes = (
            require_read_client()
            .table("subscription_codes")
            .select("price_allocated,is_used")
            .execute()
        ).data or []
        vendors = (
            require_read_client()
            .table("vendors")
            .select("subscription_status,status")
            .execute()
        ).data or []
        return {
            "total_revenue": sum(float(row.get("price_allocated") or 0) for row in codes if row.get("is_used")),
            "active_paid_vendors": sum(
                1 for vendor in vendors
                if vendor.get("status") == "active" and vendor.get("subscription_status") == "active"
            ),
            "generated_codes": len(codes),
            "used_codes": sum(1 for row in codes if row.get("is_used")),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải doanh thu subscription: {exc}") from exc


@app.post("/api/vendors", response_model=VendorRecord, status_code=status.HTTP_201_CREATED)
async def create_vendor(
    vendor: VendorSchema,
    _: Dict[str, Any] = Depends(require_admin_user),
):
    if vendor.status not in {"active", "locked"}:
        raise HTTPException(status_code=422, detail="Trạng thái vendor không hợp lệ.")
    payload = vendor.model_dump()
    payload["code"] = _code(payload["code"])
    try:
        response = require_write_client().table("vendors").insert(payload).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Không thể tạo vendor.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tạo vendor: {exc}") from exc


@app.put("/api/vendors/{vendor_id}", response_model=VendorRecord)
async def update_vendor(
    vendor_id: UUID,
    vendor: VendorSchema,
    _: Dict[str, Any] = Depends(require_admin_user),
):
    if vendor.status not in {"active", "locked"}:
        raise HTTPException(status_code=422, detail="Trạng thái vendor không hợp lệ.")
    payload = vendor.model_dump()
    payload["code"] = _code(payload["code"])
    try:
        response = (
            require_write_client()
            .table("vendors")
            .update(payload)
            .eq("id", str(vendor_id))
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy vendor.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể cập nhật vendor: {exc}") from exc


@app.post("/api/auth/users", response_model=Dict[str, Any])
async def create_vendor_user(
    payload: CreateVendorUserSchema,
    user: Dict[str, Any] = Depends(require_management_user),
):
    caller_role = user.get("role", "")
    allowed_roles = {
        "admin": {"owner", "manager", "staff", "report-viewer"},
        "owner": {"manager", "staff", "report-viewer"},
        "manager": {"staff", "report-viewer"},
    }.get(caller_role, set())
    if payload.role not in allowed_roles:
        raise HTTPException(status_code=422, detail="Vai trò onboarding không hợp lệ.")
    if payload.vendor_id and not _is_system_admin(user):
        if str(payload.vendor_id) != _vendor_id(user):
            raise HTTPException(status_code=403, detail="Không được gán tài khoản sang vendor khác.")
    vendor_id = str(payload.vendor_id) if payload.vendor_id and _is_system_admin(user) else _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=422, detail="Phải chỉ định vendor cho tài khoản mới.")
    vendor_response = (
        require_read_client()
        .table("vendors")
        .select("id,status")
        .eq("id", vendor_id)
        .limit(1)
        .execute()
    )
    vendor_record = vendor_response.data[0] if vendor_response.data else None
    if not vendor_record:
        raise HTTPException(status_code=404, detail="Vendor không tồn tại.")
    if vendor_record.get("status") != "active":
        raise HTTPException(status_code=409, detail="Vendor đang bị khóa.")
    temp_pin = "".join(secrets.choice("0123456789") for _ in range(4))
    record = {
        "username": payload.username.strip(),
        "nickname": payload.nickname.strip() if payload.nickname else None,
        "password": None,
        "temp_pin": temp_pin,
        "vendor_id": vendor_id,
        "provider": "local",
        "role": payload.role,
        "status": "active",
    }
    try:
        response = require_write_client().table("users").insert(record).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Không thể tạo tài khoản vendor.")
        created = response.data[0]
        return {
            "status": "success",
            "temporary_pin": temp_pin,
            "user": _auth_user_from_row(created).model_dump(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tạo tài khoản vendor: {exc}") from exc


@app.put("/api/auth/profile", response_model=AuthUser)
async def update_profile(
    profile: ProfileUpdateSchema,
    user: Dict[str, Any] = Depends(require_bearer_user),
):
    try:
        nickname = profile.nickname.strip() if profile.nickname else None
        response = (
            require_write_client()
            .table("users")
            .update({"nickname": nickname})
            .eq("id", user["sub"])
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy tài khoản.")
        return _auth_user_from_row(response.data[0])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể cập nhật thông tin cá nhân: {exc}") from exc


@app.post("/api/auth/redeem-code", response_model=AuthUser)
async def redeem_subscription_code(
    payload: RedeemCodeSchema,
    user: Dict[str, Any] = Depends(require_bearer_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không sử dụng mã gia hạn vendor.")
    code = payload.code.strip().upper()
    try:
        code_response = (
            require_read_client()
            .table("subscription_codes")
            .select("id,code,duration_months,is_used")
            .eq("code", code)
            .limit(1)
            .execute()
        )
        subscription_code = code_response.data[0] if code_response.data else None
        if not subscription_code or subscription_code.get("is_used"):
            raise HTTPException(status_code=400, detail="Mã gia hạn không tồn tại hoặc đã được sử dụng.")

        vendor_response = (
            require_read_client()
            .table("vendors")
            .select("id,subscription_due_date")
            .eq("id", vendor_id)
            .limit(1)
            .execute()
        )
        vendor = vendor_response.data[0] if vendor_response.data else None
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor hiện tại không tồn tại.")
        due_date = date.fromisoformat(str(vendor["subscription_due_date"])) if vendor.get("subscription_due_date") else date.today()
        next_due_date = _add_months(max(date.today(), due_date), int(subscription_code["duration_months"]))
        require_write_client().table("vendors").update({
            "subscription_due_date": next_due_date.isoformat(),
            "subscription_status": "active",
        }).eq("id", vendor_id).execute()
        used_response = (
            require_write_client()
            .table("subscription_codes")
            .update({
                "is_used": True,
                "used_by_vendor_id": vendor_id,
                "used_at": datetime.utcnow().isoformat(),
            })
            .eq("id", subscription_code["id"])
            .eq("is_used", False)
            .execute()
        )
        if not used_response.data:
            raise HTTPException(status_code=409, detail="Mã vừa được sử dụng bởi phiên khác.")
        record = (
            require_read_client()
            .table("users")
            .select("id,username,nickname,email,provider,role,status,vendor_id")
            .eq("id", user["sub"])
            .limit(1)
            .execute()
        ).data[0]
        record.update(_subscription_fields(vendor_id))
        record["vendor_name"] = _vendor_name_for_id(vendor_id)
        return _auth_user_from_row(record)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể gia hạn vendor: {exc}") from exc


@app.put("/api/auth/users/{user_id}", response_model=AuthUser)
async def assign_vendor_user(
    user_id: UUID,
    assignment: AssignVendorUserSchema,
    _: Dict[str, Any] = Depends(require_admin_user),
):
    if assignment.role not in {"owner", "manager", "staff", "report-viewer"}:
        raise HTTPException(status_code=422, detail="Vai trò vendor không hợp lệ.")
    if assignment.status not in {"active", "locked"}:
        raise HTTPException(status_code=422, detail="Trạng thái tài khoản không hợp lệ.")
    vendor = (
        require_read_client()
        .table("vendors")
        .select("id,status")
        .eq("id", str(assignment.vendor_id))
        .limit(1)
        .execute()
    )
    if not vendor.data:
        raise HTTPException(status_code=404, detail="Vendor không tồn tại.")
    try:
        response = (
            require_write_client()
            .table("users")
            .update({
                "vendor_id": str(assignment.vendor_id),
                "role": assignment.role,
                "status": assignment.status,
            })
            .eq("id", str(user_id))
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy tài khoản.")
        return _auth_user_from_row(response.data[0])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể gán tài khoản cho vendor: {exc}") from exc


@app.post("/api/auth/change-password")
async def change_password(
    payload: ChangePasswordSchema,
    user: Dict[str, Any] = Depends(require_bearer_user),
):
    try:
        client = require_write_client()
        response = (
            client.table("users")
            .select("id,username,nickname,email,provider,role,status,password,temp_pin,vendor_id")
            .eq("id", user["sub"])
            .limit(1)
            .execute()
        )
        record = response.data[0] if response.data else None
        if not record or record["status"] != "active":
            raise HTTPException(status_code=401, detail="Tài khoản không còn hoạt động.")
        password_matches = bool(
            record.get("password")
            and pwd_context.verify(payload.old_password, record["password"])
        )
        pin_matches = bool(record.get("temp_pin") and payload.old_password == record["temp_pin"])
        if not password_matches and not pin_matches:
            raise HTTPException(status_code=401, detail="Mật khẩu hiện tại không đúng.")
        updated = (
            client.table("users")
            .update({"password": pwd_context.hash(payload.new_password), "temp_pin": None})
            .eq("id", user["sub"])
            .execute()
        )
        if not updated.data:
            raise HTTPException(status_code=404, detail="Không thể cập nhật mật khẩu.")
        refreshed_user = updated.data[0]
        refreshed_user["must_change_password"] = False
        refreshed_user["vendor_name"] = _vendor_name_for_id(refreshed_user.get("vendor_id"))
        refreshed_user.update(_subscription_fields(refreshed_user.get("vendor_id")))
        return {
            "status": "success",
            "message": "Đã cập nhật mật khẩu.",
            "access_token": _create_app_token(refreshed_user),
            "token_type": "bearer",
            "user": _auth_user_from_row(refreshed_user).model_dump(),
            "must_change_password": False,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể đổi mật khẩu: {exc}") from exc


@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    file_path = Path(__file__).with_name("index.html")
    if file_path.exists():
        return FileResponse(file_path)

    return """
    <html>
        <head><title>VN Food v2.0 API</title></head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 100px;">
            <h1 style="color: #16a34a;">VN Food v2.0 Backend hoạt động ổn định!</h1>
            <p>Vui lòng đặt file <code>index.html</code> (Frontend) vào cùng thư mục chạy để kích hoạt giao diện.</p>
            <p>Tài liệu API Swagger tự động tại: <a href="/docs">/docs</a></p>
        </body>
    </html>
    """


@app.get("/app.js")
async def serve_app_js():
    file_path = Path(__file__).with_name("app.js")
    if file_path.exists():
        return FileResponse(file_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="app.js not found")


@app.get("/styles.css")
async def serve_styles_css():
    file_path = Path(__file__).with_name("styles.css")
    if file_path.exists():
        return FileResponse(file_path, media_type="text/css")
    raise HTTPException(status_code=404, detail="styles.css not found")


@app.get("/manifest.json")
async def serve_manifest():
    file_path = Path(__file__).with_name("manifest.json")
    if file_path.exists():
        return FileResponse(file_path, media_type="application/manifest+json")
    raise HTTPException(status_code=404, detail="manifest.json not found")


@app.get("/sw.js")
async def serve_service_worker():
    file_path = Path(__file__).with_name("sw.js")
    if file_path.exists():
        return FileResponse(file_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="sw.js not found")


@app.get("/api/schools", response_model=List[SchoolRecord])
async def get_schools():
    try:
        response = _scope_query(
            require_read_client().table("schools").select(_school_select())
        ).order("created_at").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn danh sách trường: {exc}",
        )


@app.post("/api/schools", status_code=status.HTTP_201_CREATED)
async def create_school(school: SchoolSchema):
    try:
        data = _school_payload(school.model_dump())
        response = require_write_client().table("schools").upsert(
            _scope_payload(data), on_conflict="vendor_id,code"
        ).execute()
        if not response.data:
            raise HTTPException(
                status_code=400, detail="Thao tác lưu điểm trường thất bại."
            )
        return {"status": "success", "data": response.data[0]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi ghi nhận điểm trường mới lên mây: {exc}",
        )


@app.delete("/api/schools/{school_id}")
async def delete_school(school_id: str):
    try:
        query = _scope_query(require_write_client().table("schools").delete())
        if _is_uuid(school_id):
            query.eq("id", school_id)
        else:
            query.eq("code", _code(school_id))
        query.execute()
        return {"status": "success", "message": f"Đã xóa thành công điểm trường {school_id}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi xóa điểm trường khỏi mây: {exc}",
        )


@app.get("/api/products", response_model=List[ProductRecord])
async def get_products():
    try:
        response = _scope_query(
            require_read_client().table("products").select(_product_select())
        ).order("code").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn danh mục thực phẩm: {exc}",
        )


@app.get("/api/categories", response_model=List[CategoryRecord])
async def get_categories():
    try:
        response = _scope_query(
            require_read_client().table("categories").select("id,name,created_at")
        ).order("created_at").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn nhóm hàng: {exc}",
        )


@app.post("/api/categories", response_model=CategoryRecord, status_code=status.HTTP_201_CREATED)
async def create_category(category: CategorySchema):
    try:
        payload = jsonable_encoder(category)
        payload["name"] = payload["name"].strip()
        if not payload["name"]:
            raise HTTPException(status_code=422, detail="Tên nhóm hàng không được để trống.")
        response = require_write_client().table("categories").upsert(
            _scope_payload(payload), on_conflict="vendor_id,name"
        ).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Thao tác lưu nhóm hàng thất bại.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi thêm nhóm hàng: {exc}",
        )


@app.put("/api/categories/{category_id}", response_model=CategoryRecord)
async def update_category(category_id: UUID, category: CategorySchema):
    try:
        payload = jsonable_encoder(category)
        payload["name"] = payload["name"].strip()
        if not payload["name"]:
            raise HTTPException(status_code=422, detail="Tên nhóm hàng không được để trống.")
        response = _scope_query(
            require_write_client().table("categories").update(_scope_payload(payload))
        ).eq("id", str(category_id)).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhóm hàng.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi cập nhật nhóm hàng: {exc}",
        )


@app.delete("/api/categories/{category_id}")
async def delete_category(category_id: UUID):
    try:
        _scope_query(require_write_client().table("categories").delete()).eq(
            "id", str(category_id)
        ).execute()
        return {"status": "success", "message": f"Đã xóa nhóm hàng {category_id}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi xóa nhóm hàng: {exc}",
        )


@app.post("/api/categories/bulk-upsert")
async def bulk_upsert_categories(categories_list: List[CategorySchemaWithId]):
    if not categories_list:
        return {"status": "success", "upserted_count": 0, "data": []}
    try:
        payload = jsonable_encoder(categories_list)
        for item in payload:
            item["name"] = item["name"].strip()
            if not item["name"]:
                raise HTTPException(status_code=422, detail="Tên nhóm hàng không được để trống.")
        client = require_write_client()
        data = []
        for chunk in _chunks(payload):
            data.extend(await asyncio.to_thread(_run_upsert_chunk, client, "categories", chunk, "id"))
            await asyncio.sleep(0)
        return {
            "status": "success",
            "upserted_count": len(data),
            "data": data,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi đồng bộ nhóm hàng hàng loạt: {exc}")


@app.post("/api/products", status_code=status.HTTP_201_CREATED)
async def create_product(product: ProductSchema):
    try:
        data = jsonable_encoder(product)
        data["code"] = _code(data["code"])
        response = require_write_client().table("products").upsert(
            _scope_payload(data), on_conflict="vendor_id,code"
        ).execute()
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi thêm thực phẩm vào danh mục: {exc}",
        )


@app.post("/api/products/bulk")
async def create_products_bulk(products_list: List[ProductSchema]):
    if not products_list:
        return {"status": "success", "inserted_count": 0, "data": []}
    try:
        payload = jsonable_encoder(products_list)
        for item in payload:
            item["code"] = _code(item["code"])
        client = require_write_client()
        data = []
        for chunk in _chunks(payload):
            data.extend(await asyncio.to_thread(_run_upsert_chunk, client, "products", chunk, "vendor_id,code"))
            await asyncio.sleep(0)
        return {
            "status": "success",
            "inserted_count": len(data),
            "data": data,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Nhập hàng loạt thực phẩm thất bại: {exc}",
        )


@app.post("/api/products/bulk-upsert")
async def bulk_upsert_products(products_list: List[ProductSchemaWithId]):
    if not products_list:
        return {"status": "success", "upserted_count": 0, "data": []}
    try:
        payload = jsonable_encoder(products_list)
        for item in payload:
            item["code"] = _code(item["code"])
        client = require_write_client()
        data = []
        for chunk in _chunks(payload):
            data.extend(await asyncio.to_thread(_run_upsert_chunk, client, "products", chunk, "id"))
            await asyncio.sleep(0)
        return {
            "status": "success",
            "upserted_count": len(data),
            "data": data,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi đồng bộ thực phẩm hàng loạt: {exc}")


@app.delete("/api/products/{code}")
async def delete_product(code: str):
    try:
        query = _scope_query(require_write_client().table("products").delete())
        if _is_uuid(code):
            query.eq("id", code)
        else:
            query.eq("code", _code(code))
        query.execute()
        return {
            "status": "success",
            "message": f"Đã xóa thực phẩm mã {code} khỏi hệ thống",
        }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi xóa thực phẩm khỏi danh mục: {exc}",
        )


@app.get("/api/stock")
async def get_stock():
    try:
        response = _scope_query(
            require_read_client().table("stock").select(_stock_select())
        ).execute()
        return {item["product_id"]: item["qty"] for item in response.data}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi lấy thông tin tồn kho: {exc}",
        )


@app.post("/api/stock/upsert")
async def upsert_stock(stock_item: StockSchema):
    try:
        data = stock_item.model_dump(mode="json")
        if not data.get("product_id") and data.get("product_code"):
            resolved = _lookup_id_by_code("products", "code", data["product_code"])
            data["product_id"] = resolved or data.pop("product_code")
        data.pop("product_code", None)
        if not data.get("product_id"):
            raise HTTPException(status_code=400, detail="Thiếu product_id cho tồn kho.")
        response = require_write_client().table("stock").upsert(
            _scope_payload(data), on_conflict="vendor_id,product_id"
        ).execute()
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi điều chỉnh tồn kho: {exc}",
        )


@app.get("/api/orders", response_model=List[DailyOrderRecord])
async def get_daily_orders(date: date):
    try:
        response = _scope_query(
            require_read_client().table("daily_orders").select(_order_select())
        ).eq("delivery_date", date).execute()
        return _attach_order_batches(response.data or [])
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn đơn hàng ngày {date}: {exc}",
        )


@app.post("/api/orders/upsert")
async def upsert_daily_order(order_item: OrderUpsertSchema):
    try:
        data = _normalise_order_payload(jsonable_encoder(order_item))
        client = require_write_client()
        if data["qty"] <= 0 and not data["batches"]:
            (
                _scope_query(client.table("daily_orders").delete())
                .eq("delivery_date", data["delivery_date"])
                .eq("product_id", str(data["product_id"]))
                .eq("school_id", data["school_id"])
                .execute()
            )
            return {"status": "deleted", "message": "Đã xóa phân bổ do SL bằng 0."}

        response = client.table("daily_orders").upsert(
            _scope_payload({key: value for key, value in data.items() if key != "batches"}),
            on_conflict="vendor_id,delivery_date,product_id,school_id",
        ).execute()
        parent = response.data[0]
        _sync_order_batches(client, str(parent["id"]), data["batches"])
        parent["batches"] = data["batches"]
        return {"status": "success", "data": parent}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi đồng bộ chi tiết ô phân bổ lên Cloud: {exc}",
        )


@app.post("/api/orders/bulk-upsert")
async def bulk_upsert_daily_orders(orders_list: List[OrderUpsertSchema]):
    if not orders_list:
        return {
            "status": "success",
            "message": "Không có dữ liệu cần xử lý.",
            "upserted_count": 0,
            "deleted_count": 0,
        }
    try:
        payload = jsonable_encoder(orders_list)
        client = require_write_client()
        upserted_count = 0
        deleted_count = 0
        processed_chunks = 0
        for chunk in _chunks(payload):
            result = await asyncio.to_thread(_process_order_chunk, client, chunk)
            upserted_count += result["upserted_count"]
            deleted_count += result["deleted_count"]
            processed_chunks += 1
            await asyncio.sleep(0)
        return {
            "status": "success",
            "upserted_count": upserted_count,
            "deleted_count": deleted_count,
            "processed_chunks": processed_chunks,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi đồng bộ dữ liệu hàng loạt: {exc}",
        )


@app.delete("/api/orders")
async def clear_daily_orders(date: date):
    try:
        _scope_query(require_write_client().table("daily_orders").delete()).eq(
            "delivery_date", date.isoformat()
        ).execute()
        return {"status": "success", "message": f"Đã xóa sạch dữ liệu ngày {date}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi dọn sạch dữ liệu ngày: {exc}",
        )


GOOGLE_SHEET_ID_PATTERN = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")


def _google_sheet_id(sheet_url: str) -> Optional[str]:
    match = GOOGLE_SHEET_ID_PATTERN.search(str(sheet_url))
    return match.group(1) if match else None


def _google_sheet_config_query(config_id: UUID, vendor_id: str, client: Client) -> Any:
    return (
        client.table("google_sheet_configs")
        .select(
            "id,vendor_id,school_id,sheet_name,sheet_url,sheet_id,sync_direction,"
            "auto_sync_enabled,webhook_token,last_synced_at,status,created_at"
        )
        .eq("id", str(config_id))
        .eq("vendor_id", vendor_id)
        .limit(1)
    )


def _require_google_config(config_id: UUID, vendor_id: str, client: Client) -> Dict[str, Any]:
    response = _google_sheet_config_query(config_id, vendor_id, client).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình Google Sheets.")
    return response.data[0]


def _google_sheet_catalog_payload(vendor_id: str, client: Client) -> List[Dict[str, Any]]:
    categories = (
        client.table("categories")
        .select("id,name")
        .eq("vendor_id", vendor_id)
        .execute()
    ).data or []
    category_names = {str(row["id"]): row.get("name") or "Chưa phân nhóm" for row in categories}
    products = (
        client.table("products")
        .select("id,code,name,unit,price,category_id")
        .eq("vendor_id", vendor_id)
        .order("code")
        .execute()
    ).data or []
    return [
        {
            "category": category_names.get(str(product.get("category_id")), "Chưa phân nhóm"),
            "code": product.get("code") or "",
            "name": product.get("name") or "",
            "unit": product.get("unit") or "",
            "price": product.get("price") or 0,
            "status": "Active",
            "product_id": product.get("id"),
        }
        for product in products
    ]


def _google_sheet_payload(
    config: Dict[str, Any],
    delivery_date: Optional[date],
    client: Client,
) -> Dict[str, Any]:
    vendor_id = str(config["vendor_id"])
    orders_query = (
        client.table("daily_orders")
        .select("id,delivery_date,product_id,school_id,qty")
        .eq("vendor_id", vendor_id)
        .order("delivery_date")
    )
    if delivery_date:
        orders_query = orders_query.eq("delivery_date", delivery_date.isoformat())
    if config.get("school_id"):
        orders_query = orders_query.eq("school_id", str(config["school_id"]))
    orders = orders_query.execute().data or []
    return {
        "catalog": _google_sheet_catalog_payload(vendor_id, client),
        "orders": orders,
        "delivery_date": delivery_date.isoformat() if delivery_date else None,
    }


def _mark_google_config_synced(config_id: UUID, vendor_id: str, client: Client) -> None:
    client.table("google_sheet_configs").update(
        {"last_synced_at": datetime.utcnow().isoformat()}
    ).eq("id", str(config_id)).eq("vendor_id", vendor_id).execute()


@app.get("/api/sync/google-sheets/config", response_model=List[GoogleSheetConfigRecord])
async def list_google_sheet_configs(
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    try:
        return (
            require_read_client()
            .table("google_sheet_configs")
            .select(
                "id,vendor_id,school_id,sheet_name,sheet_url,sheet_id,sync_direction,"
                "auto_sync_enabled,webhook_token,last_synced_at,status,created_at"
            )
            .eq("vendor_id", vendor_id)
            .order("created_at")
            .execute()
        ).data or []
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải cấu hình Google Sheets: {exc}") from exc


@app.post(
    "/api/sync/google-sheets/config",
    response_model=GoogleSheetConfigRecord,
    status_code=status.HTTP_201_CREATED,
)
async def create_google_sheet_config(
    payload: GoogleSheetConfigCreateSchema,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    sheet_id = payload.sheet_id or _google_sheet_id(payload.sheet_url)
    if not sheet_id:
        raise HTTPException(status_code=422, detail="URL Google Sheets không chứa Spreadsheet ID hợp lệ.")
    if payload.school_id:
        school = (
            require_read_client()
            .table("schools")
            .select("id")
            .eq("id", str(payload.school_id))
            .eq("vendor_id", vendor_id)
            .limit(1)
            .execute()
        ).data
        if not school:
            raise HTTPException(status_code=404, detail="Trường không thuộc vendor hiện tại.")
    record = {
        **payload.model_dump(exclude={"sheet_id"}),
        "vendor_id": vendor_id,
        "sheet_id": sheet_id,
        "webhook_token": secrets.token_urlsafe(24),
        "status": "active",
    }
    try:
        response = require_write_client().table("google_sheet_configs").insert(record).execute()
        if not response.data:
            raise HTTPException(status_code=400, detail="Không thể lưu cấu hình Google Sheets.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi lưu cấu hình Google Sheets: {exc}") from exc


@app.put("/api/sync/google-sheets/config/{config_id}", response_model=GoogleSheetConfigRecord)
async def update_google_sheet_config(
    config_id: UUID,
    payload: GoogleSheetConfigCreateSchema,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    sheet_id = payload.sheet_id or _google_sheet_id(payload.sheet_url)
    if not sheet_id:
        raise HTTPException(status_code=422, detail="URL Google Sheets không chứa Spreadsheet ID hợp lệ.")
    if payload.school_id:
        school = (
            require_read_client()
            .table("schools")
            .select("id")
            .eq("id", str(payload.school_id))
            .eq("vendor_id", vendor_id)
            .limit(1)
            .execute()
        ).data
        if not school:
            raise HTTPException(status_code=404, detail="Trường không thuộc vendor hiện tại.")
    record = {
        **payload.model_dump(exclude={"sheet_id"}),
        "sheet_id": sheet_id,
    }
    try:
        response = (
            require_write_client()
            .table("google_sheet_configs")
            .update(record)
            .eq("id", str(config_id))
            .eq("vendor_id", vendor_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình Google Sheets.")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi cập nhật cấu hình Google Sheets: {exc}") from exc


@app.delete("/api/sync/google-sheets/config/{config_id}")
async def delete_google_sheet_config(
    config_id: UUID,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    try:
        response = (
            require_write_client()
            .table("google_sheet_configs")
            .delete()
            .eq("id", str(config_id))
            .eq("vendor_id", vendor_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình Google Sheets.")
        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi xóa cấu hình Google Sheets: {exc}") from exc


@app.post("/api/sync/google-sheets/test")
async def test_google_sheet_config(
    config_id: UUID,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    config = _require_google_config(config_id, vendor_id, require_read_client())
    sheet_id = config.get("sheet_id") or _google_sheet_id(config.get("sheet_url", ""))
    if not sheet_id:
        return {"status": "error", "message": "Không đọc được Spreadsheet ID từ URL."}
    csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            response = await client.get(csv_url)
        if response.status_code == 200:
            return {"status": "connected", "message": "Sheet đang công khai và có thể đọc qua CSV export."}
        return {
            "status": "configured",
            "message": "Đã nhận diện Sheet nhưng quyền đọc trực tiếp bị giới hạn; dùng Apps Script để đồng bộ riêng tư.",
        }
    except httpx.HTTPError:
        return {
            "status": "configured",
            "message": "Đã nhận diện Spreadsheet ID; chưa thể kiểm tra mạng trực tiếp.",
        }


@app.post("/api/sync/google-sheets/manual-trigger")
async def manual_google_sheet_sync(
    payload: GoogleSheetManualTriggerSchema,
    user: Dict[str, Any] = Depends(require_management_user),
):
    vendor_id = _vendor_id(user)
    if not vendor_id:
        raise HTTPException(status_code=403, detail="Admin không có cấu hình Sheets theo vendor.")
    try:
        client = require_read_client()
        config = _require_google_config(payload.config_id, vendor_id, client)
        sync_payload = _google_sheet_payload(config, payload.delivery_date, client)
        return {
            "status": "bridge_ready",
            "mode": config["sync_direction"],
            "message": "Đã tạo gói dữ liệu; Apps Script cần chạy để ghi vào Google Sheet.",
            "config": config,
            "payload": sync_payload,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi tạo gói đồng bộ Google Sheets: {exc}") from exc


@app.get("/api/sync/google-sheets/payload/{config_id}")
async def public_google_sheet_payload(config_id: UUID, token: str, delivery_date: Optional[date] = None):
    client = require_read_client()
    response = client.table("google_sheet_configs").select(
        "id,vendor_id,school_id,sheet_name,sheet_url,sheet_id,sync_direction,"
        "auto_sync_enabled,webhook_token,last_synced_at,status,created_at"
    ).eq("id", str(config_id)).limit(1).execute()
    config = response.data[0] if response.data else None
    if not config or not secrets.compare_digest(str(config.get("webhook_token")), token):
        raise HTTPException(status_code=401, detail="Sync token không hợp lệ.")
    sync_payload = _google_sheet_payload(config, delivery_date, client)
    _mark_google_config_synced(config_id, str(config["vendor_id"]), require_write_client())
    return sync_payload


@app.post("/api/sync/google-sheets/webhook")
async def google_sheet_webhook(payload: GoogleSheetWebhookSchema):
    read_client = require_read_client()
    config_response = read_client.table("google_sheet_configs").select(
        "id,vendor_id,school_id,webhook_token,status"
    ).eq("id", str(payload.config_id)).limit(1).execute()
    config = config_response.data[0] if config_response.data else None
    if not config or config.get("status") != "active" or not secrets.compare_digest(
        str(config.get("webhook_token")), payload.token
    ):
        raise HTTPException(status_code=401, detail="Sync token không hợp lệ.")
    vendor_id = str(config["vendor_id"])
    write_client = require_write_client()
    accepted = 0
    if payload.entity == "catalog":
        for record in payload.records:
            code = _code(str(record.get("code") or record.get("shortcut") or ""))
            name = str(record.get("name") or "").strip()
            unit = str(record.get("unit") or "").strip()
            if not code or not name or not unit:
                continue
            category_name = str(record.get("category") or record.get("category_name") or "").strip()
            category_id = None
            if category_name:
                category_response = write_client.table("categories").upsert(
                    {"vendor_id": vendor_id, "name": category_name},
                    on_conflict="vendor_id,name",
                ).execute()
                if category_response.data:
                    category_id = category_response.data[0].get("id")
            write_client.table("products").upsert(
                {
                    "vendor_id": vendor_id,
                    "code": code,
                    "name": name,
                    "unit": unit,
                    "price": float(record.get("price") or 0),
                    "category_id": category_id,
                },
                on_conflict="vendor_id,code",
            ).execute()
            accepted += 1
    else:
        default_date = payload.delivery_date or date.today()
        for record in payload.records:
            product_id = record.get("product_id")
            school_id = record.get("school_id") or config.get("school_id")
            if not product_id and record.get("code"):
                product_response = read_client.table("products").select("id").eq(
                    "vendor_id", vendor_id
                ).eq("code", _code(str(record["code"]))).limit(1).execute()
                product_id = product_response.data[0]["id"] if product_response.data else None
            if not product_id or not school_id:
                continue
            school_response = read_client.table("schools").select("id").eq(
                "vendor_id", vendor_id
            ).eq("id", str(school_id)).limit(1).execute()
            if not school_response.data:
                continue
            write_client.table("daily_orders").upsert(
                {
                    "vendor_id": vendor_id,
                    "delivery_date": str(record.get("delivery_date") or default_date),
                    "product_id": str(product_id),
                    "school_id": str(school_id),
                    "qty": float(record.get("qty") or 0),
                },
                on_conflict="vendor_id,delivery_date,product_id,school_id",
            ).execute()
            accepted += 1
    _mark_google_config_synced(payload.config_id, vendor_id, write_client)
    return {"status": "success", "accepted_records": accepted}
