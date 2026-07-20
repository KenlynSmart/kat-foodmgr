import os
import secrets
from pathlib import Path
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

import jwt
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


class LoginSchema(BaseModel):
    username: str
    password: str


class ProfileUpdateSchema(BaseModel):
    nickname: Optional[str] = Field(default=None, max_length=100)


class ChangePasswordSchema(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class AuthUser(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    email: Optional[str] = None
    provider: str
    role: str
    status: str


class AuthResponse(BaseModel):
    status: str = "success"
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str
    user: AuthUser


def _create_app_token(user: Dict[str, Any]) -> str:
    now = datetime.utcnow()
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
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
    )


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


PUBLIC_API_PATHS = {
    "/api/auth/login",
    "/api/auth/google/url",
    "/api/auth/google/callback",
}


@app.middleware("http")
async def protect_api_routes(request: Request, call_next):
    if (
        request.method != "OPTIONS"
        and request.url.path.startswith("/api/")
        and request.url.path not in PUBLIC_API_PATHS
    ):
        try:
            require_bearer_user(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


class SchoolSchema(BaseModel):
    code: str = Field(..., description="Mã viết tắt của điểm trường (Ví dụ: mitsuba)")
    name: str = Field(..., description="Tên đầy đủ của trường mầm non")
    bg_color: str = Field("bg-sky-50", description="Màu nền Tailwind đại diện")
    text_color: str = Field("text-sky-850", description="Màu chữ Tailwind đại diện")
    border_color: str = Field("border-sky-200", description="Màu viền Tailwind")
    icon: str = Field("fa-school", description="Icon FontAwesome hiển thị")


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
    return "id,code,name,bg_color,text_color,border_color,icon,created_at"


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
    response = (
        require_read_client()
        .table("daily_order_batches")
        .select(_order_batch_select())
        .in_("daily_order_id", order_ids)
        .order("created_at")
        .execute()
    )
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
    return data


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except Exception:
        return False


def _lookup_id_by_code(table: str, code_field: str, code: str) -> Optional[str]:
    response = (
        require_read_client()
        .table(table)
        .select("id")
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
    client.table("daily_order_batches").delete().eq("daily_order_id", daily_order_id).execute()
    payload = [
        {
            **({"id": batch["id"]} if batch.get("id") else {}),
            "daily_order_id": daily_order_id,
            "qty_change": batch["qty_change"],
            "note": str(batch.get("note") or "").strip(),
        }
        for batch in batches
        if batch["qty_change"] != 0
    ]
    if payload:
        client.table("daily_order_batches").insert(payload).execute()


@app.post("/api/auth/login", response_model=AuthResponse)
async def login(credentials: LoginSchema):
    try:
        response = (
            require_read_client()
            .table("users")
            .select("id,username,nickname,password,email,provider,role,status")
            .eq("username", credentials.username.strip())
            .eq("provider", "local")
            .limit(1)
            .execute()
        )
        user = response.data[0] if response.data else None
        if (
            not user
            or not user.get("password")
            or not pwd_context.verify(credentials.password, user["password"])
        ):
            raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng.")
        if user["status"] != "active":
            raise HTTPException(status_code=403, detail="Tài khoản đã bị khóa.")
        return AuthResponse(
            access_token=_create_app_token(user),
            role=user["role"],
            username=user["username"],
            user=_auth_user_from_row(user),
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
            .select("id,username,nickname,email,provider,role,status")
            .eq("id", user["sub"])
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=401, detail="Tài khoản không còn tồn tại.")
        return _auth_user_from_row(response.data[0])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải tài khoản: {exc}") from exc


@app.get("/api/auth/users", response_model=List[AuthUser])
async def list_users(_: Dict[str, Any] = Depends(require_admin_user)):
    try:
        response = (
            require_read_client()
            .table("users")
            .select("id,username,nickname,email,provider,role,status")
            .order("created_at")
            .execute()
        )
        return [_auth_user_from_row(row) for row in response.data or []]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tải danh sách tài khoản: {exc}") from exc


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


@app.post("/api/auth/change-password")
async def change_password(
    payload: ChangePasswordSchema,
    user: Dict[str, Any] = Depends(require_bearer_user),
):
    try:
        client = require_write_client()
        response = (
            client.table("users")
            .select("id,password,status")
            .eq("id", user["sub"])
            .limit(1)
            .execute()
        )
        record = response.data[0] if response.data else None
        if not record or record["status"] != "active":
            raise HTTPException(status_code=401, detail="Tài khoản không còn hoạt động.")
        if not record.get("password") or not pwd_context.verify(payload.old_password, record["password"]):
            raise HTTPException(status_code=401, detail="Mật khẩu hiện tại không đúng.")
        updated = (
            client.table("users")
            .update({"password": pwd_context.hash(payload.new_password)})
            .eq("id", user["sub"])
            .execute()
        )
        if not updated.data:
            raise HTTPException(status_code=404, detail="Không thể cập nhật mật khẩu.")
        return {"status": "success", "message": "Đã cập nhật mật khẩu."}
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
        response = require_read_client().table("schools").select(_school_select()).order("created_at").execute()
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
        response = (
            require_write_client()
            .table("schools")
            .upsert(data, on_conflict="code")
            .execute()
        )
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
        query = require_write_client().table("schools").delete()
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
        response = require_read_client().table("products").select(_product_select()).order("code").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn danh mục thực phẩm: {exc}",
        )


@app.get("/api/categories", response_model=List[CategoryRecord])
async def get_categories():
    try:
        response = (
            require_read_client()
            .table("categories")
            .select("id,name,created_at")
            .order("created_at")
            .execute()
        )
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
        response = (
            require_write_client()
            .table("categories")
            .upsert(payload, on_conflict="name")
            .execute()
        )
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
        response = (
            require_write_client()
            .table("categories")
            .update(payload)
            .eq("id", str(category_id))
            .execute()
        )
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
        require_write_client().table("categories").delete().eq("id", str(category_id)).execute()
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
        response = (
            require_write_client()
            .table("categories")
            .upsert(payload, on_conflict="id")
            .execute()
        )
        return {
            "status": "success",
            "upserted_count": len(response.data or []),
            "data": response.data or [],
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
        response = (
            require_write_client().table("products").upsert(data, on_conflict="code").execute()
        )
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
        response = (
            require_write_client()
            .table("products")
            .upsert(payload, on_conflict="code")
            .execute()
        )
        return {
            "status": "success",
            "inserted_count": len(response.data or []),
            "data": response.data or [],
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
        response = (
            require_write_client()
            .table("products")
            .upsert(payload, on_conflict="id")
            .execute()
        )
        return {
            "status": "success",
            "upserted_count": len(response.data or []),
            "data": response.data or [],
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Lỗi đồng bộ thực phẩm hàng loạt: {exc}")


@app.delete("/api/products/{code}")
async def delete_product(code: str):
    try:
        query = require_write_client().table("products").delete()
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
        response = require_read_client().table("stock").select(_stock_select()).execute()
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
        response = (
            require_write_client().table("stock")
            .upsert(data, on_conflict="product_id")
            .execute()
        )
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi điều chỉnh tồn kho: {exc}",
        )


@app.get("/api/orders", response_model=List[DailyOrderRecord])
async def get_daily_orders(date: date):
    try:
        response = (
            require_read_client().table("daily_orders")
            .select(_order_select())
            .eq("delivery_date", date)
            .execute()
        )
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
                client.table("daily_orders")
                .delete()
                .eq("delivery_date", data["delivery_date"])
                .eq("product_id", str(data["product_id"]))
                .eq("school_id", data["school_id"])
                .execute()
            )
            return {"status": "deleted", "message": "Đã xóa phân bổ do SL bằng 0."}

        response = (
            client.table("daily_orders")
            .upsert(
                {key: value for key, value in data.items() if key != "batches"},
                on_conflict="delivery_date,product_id,school_id",
            )
            .execute()
        )
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
        upsert_payload = []
        delete_payload = []
        for item in payload:
            normalised = _normalise_order_payload(item)
            (delete_payload if normalised["qty"] <= 0 and not normalised["batches"] else upsert_payload).append(normalised)

        client = require_write_client()
        upserted_count = 0
        if upsert_payload:
            response = client.table("daily_orders").upsert(
                [{key: value for key, value in item.items() if key != "batches"} for item in upsert_payload],
                on_conflict="delivery_date,product_id,school_id",
            ).execute()
            upserted_count = len(response.data or [])
            parents_by_key = {
                (
                    str(parent["delivery_date"]),
                    str(parent["product_id"]),
                    str(parent["school_id"]),
                ): parent
                for parent in response.data or []
            }
            for item in upsert_payload:
                key = (item["delivery_date"], str(item["product_id"]), str(item["school_id"]))
                parent = parents_by_key[key]
                _sync_order_batches(client, str(parent["id"]), item["batches"])

        deleted_count = 0
        for item in delete_payload:
            client.table("daily_orders").delete() \
                .eq("delivery_date", item["delivery_date"]) \
                .eq("product_id", item["product_id"]) \
                .eq("school_id", item["school_id"]) \
                .execute()
            deleted_count += 1
        return {
            "status": "success",
            "upserted_count": upserted_count,
            "deleted_count": deleted_count,
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
        require_write_client().table("daily_orders").delete().eq("delivery_date", date.isoformat()).execute()
        return {"status": "success", "message": f"Đã xóa sạch dữ liệu ngày {date}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi dọn sạch dữ liệu ngày: {exc}",
        )
