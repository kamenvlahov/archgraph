from fastapi import APIRouter, Depends

from app.orders.dependencies import get_service
from app.orders.models import Order
from app.orders.schemas import OrderOut, PlaceOrderIn
from app.orders.service import OrderService

router = APIRouter(prefix="/orders", tags=["orders"])


@router.post("", status_code=201)
async def place_order(body: PlaceOrderIn, service: OrderService = Depends(get_service)) -> OrderOut:
    return to_out(await service.place(body))


@router.get("/{order_id}")
async def get_order(order_id: int, service: OrderService = Depends(get_service)) -> OrderOut:
    return to_out(await service.get(order_id))


def to_out(order: Order):
    return OrderOut(id=order.get_id(), total=order.total(), items=len(order.items))
