from pydantic import BaseModel, Field


class OrderItemIn(BaseModel):
    sku: str
    quantity: int = Field(gt=0)
    price: float


class PlaceOrderIn(BaseModel):
    customer_id: int
    items: list[OrderItemIn]
    note: str | None = None


class OrderOut(BaseModel):
    id: int | None
    total: float
    items: int
