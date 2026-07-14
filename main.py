import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, status
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
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get(
    "SUPABASE_KEY",
    "sb_publishable_3g8a4d68v1XWEs86b-zckg_00OAZmMt",
)

try:
    supabase: Optional[Client] = (
        create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_KEY else None
    )
except Exception as exc:
    print(f"[CẢNH BÁO] Không thể kết nối tới Supabase: {exc}")
    supabase = None


class SchoolSchema(BaseModel):
    id: str = Field(..., description="Mã viết tắt của điểm trường (Ví dụ: mitsuba)")
    name: str = Field(..., description="Tên đầy đủ của trường mầm non")
    bg_color: str = Field("bg-sky-50", description="Màu nền Tailwind đại diện")
    text_color: str = Field("text-sky-850", description="Màu chữ Tailwind đại diện")
    border_color: str = Field("border-sky-200", description="Màu viền Tailwind")
    icon: str = Field("fa-school", description="Icon FontAwesome hiển thị")


class ProductSchema(BaseModel):
    code: str = Field(
        ..., description="Mã viết tắt viết thường của sản phẩm (Ví dụ: cl, tv)"
    )
    name: str = Field(..., description="Tên thực phẩm quy chuẩn")
    unit: str = Field(..., description="Đơn vị tính (Kg, Bó, Gói...)")
    price: float = Field(..., description="Đơn giá gốc cung cấp")


class StockSchema(BaseModel):
    product_code: str = Field(..., description="Mã thực phẩm cần điều chỉnh")
    qty: float = Field(..., description="Số lượng tồn kho khả dụng hiện tại")


class OrderUpsertSchema(BaseModel):
    delivery_date: str = Field(..., description="Ngày giao nhận hàng (YYYY-MM-DD)")
    product_code: str = Field(..., description="Mã mặt hàng phân bổ")
    school_id: str = Field(..., description="ID trường nhận hàng")
    qty: float = Field(..., description="Số lượng thực tế phân phối")


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


@app.get("/api/schools", response_model=List[Dict[str, Any]])
async def get_schools():
    if not supabase:
        raise HTTPException(
            status_code=503,
            detail="Hệ thống cơ sở dữ liệu Supabase chưa được cấu hình.",
        )
    try:
        response = supabase.table("schools").select("*").order("created_at").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn danh sách trường: {exc}",
        )


@app.post("/api/schools", status_code=status.HTTP_201_CREATED)
async def create_school(school: SchoolSchema):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        response = (
            supabase.table("schools")
            .upsert(school.model_dump(), on_conflict="id")
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
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        supabase.table("schools").delete().eq("id", school_id).execute()
        return {"status": "success", "message": f"Đã xóa thành công điểm trường {school_id}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi xóa điểm trường khỏi mây: {exc}",
        )


@app.get("/api/products", response_model=List[Dict[str, Any]])
async def get_products():
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        response = supabase.table("products").select("*").order("code").execute()
        return response.data
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi truy vấn danh mục thực phẩm: {exc}",
        )


@app.post("/api/products", status_code=status.HTTP_201_CREATED)
async def create_product(product: ProductSchema):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        data = product.model_dump()
        data["code"] = data["code"].strip().lower()
        response = (
            supabase.table("products").upsert(data, on_conflict="code").execute()
        )
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi thêm thực phẩm vào danh mục: {exc}",
        )


@app.delete("/api/products/{code}")
async def delete_product(code: str):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        supabase.table("products").delete().eq("code", code.lower()).execute()
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
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        response = supabase.table("stock").select("*").execute()
        return {item["product_code"]: item["qty"] for item in response.data}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi lấy thông tin tồn kho: {exc}",
        )


@app.post("/api/stock/upsert")
async def upsert_stock(stock_item: StockSchema):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        data = stock_item.model_dump()
        data["product_code"] = data["product_code"].strip().lower()
        response = (
            supabase.table("stock")
            .upsert(data, on_conflict="product_code")
            .execute()
        )
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi điều chỉnh tồn kho: {exc}",
        )


@app.get("/api/orders")
async def get_daily_orders(date: str):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        response = (
            supabase.table("daily_orders")
            .select("*")
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
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        data = order_item.model_dump()
        data["product_code"] = data["product_code"].strip().lower()

        if data["qty"] <= 0:
            (
                supabase.table("daily_orders")
                .delete()
                .eq("delivery_date", data["delivery_date"])
                .eq("product_code", data["product_code"])
                .eq("school_id", data["school_id"])
                .execute()
            )
            return {"status": "deleted", "message": "Đã xóa phân bổ do SL bằng 0."}

        response = (
            supabase.table("daily_orders")
            .upsert(
                data,
                on_conflict="delivery_date,product_code,school_id",
            )
            .execute()
        )
        return {"status": "success", "data": response.data[0]}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi đồng bộ chi tiết ô phân bổ lên Cloud: {exc}",
        )


@app.delete("/api/orders")
async def clear_daily_orders(date: str):
    if not supabase:
        raise HTTPException(
            status_code=503, detail="Cơ sở dữ liệu đám mây chưa kết nối."
        )
    try:
        supabase.table("daily_orders").delete().eq("delivery_date", date).execute()
        return {"status": "success", "message": f"Đã xóa sạch dữ liệu ngày {date}"}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi dọn sạch dữ liệu ngày: {exc}",
        )
