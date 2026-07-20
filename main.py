import os
from pathlib import Path
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import FastAPI, HTTPException, status
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field
from supabase import Client, create_client


app = FastAPI(
    title="VN Food Cloud v2.0 API Gateway",
    description="Backend phục vụ xử lý nghiệp vụ đi chợ, quản lý tồn kho và đồng bộ Supabase",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn đơn hàng ngày {date}: {exc}",
        )


@app.post("/api/orders/upsert")
async def upsert_daily_order(order_item: OrderUpsertSchema):
    try:
        data = order_item.model_dump(mode="json")
        if not data.get("product_id") and data.get("product_code"):
            resolved = _lookup_id_by_code("products", "code", data["product_code"])
            data["product_id"] = resolved or data.pop("product_code")
        if not data.get("school_id") and data.get("school_code"):
            resolved = _lookup_id_by_code("schools", "code", data["school_code"])
            data["school_id"] = resolved or data.pop("school_code")
        data.pop("product_code", None)
        data.pop("school_code", None)
        if not data.get("product_id") or not data.get("school_id"):
            raise HTTPException(status_code=400, detail="Thiếu product_id hoặc school_id cho daily_orders.")

        if data["qty"] <= 0:
            (
                require_write_client().table("daily_orders")
                .delete()
                .eq("delivery_date", data["delivery_date"])
                .eq("product_id", str(data["product_id"]))
                .eq("school_id", data["school_id"])
                .execute()
            )
            return {"status": "deleted", "message": "Đã xóa phân bổ do SL bằng 0."}

        response = (
            require_write_client().table("daily_orders")
            .upsert(
                data,
                on_conflict="delivery_date,product_id,school_id",
            )
            .execute()
        )
        return {"status": "success", "data": response.data[0]}
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
            if not item.get("product_id") and item.get("product_code"):
                item["product_id"] = _lookup_id_by_code("products", "code", item["product_code"])
            if not item.get("school_id") and item.get("school_code"):
                item["school_id"] = _lookup_id_by_code("schools", "code", item["school_code"])
            item.pop("product_code", None)
            item.pop("school_code", None)
            if not item.get("product_id") or not item.get("school_id"):
                raise HTTPException(status_code=400, detail="Thiếu product_id hoặc school_id cho daily_orders.")
            (delete_payload if item["qty"] <= 0 else upsert_payload).append(item)

        client = require_write_client()
        upserted_count = 0
        if upsert_payload:
            response = client.table("daily_orders").upsert(
                upsert_payload,
                on_conflict="delivery_date,product_id,school_id",
            ).execute()
            upserted_count = len(response.data or [])

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
