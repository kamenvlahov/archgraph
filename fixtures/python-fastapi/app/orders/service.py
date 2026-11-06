from fastapi import HTTPException

from app.orders.models import Order, OrderItem
from app.orders.pricing import apply_discount
from app.orders.repository import OrderRepository
from app.orders.schemas import PlaceOrderIn


class OrderService:
    def __init__(self, repo: OrderRepository) -> None:
        self.repo = repo

    async def place(self, data: PlaceOrderIn) -> Order:
        order = Order(customer_id=data.customer_id)
        for item in data.items:
            order.add_item(OrderItem(sku=item.sku, quantity=item.quantity, price=apply_discount(item.price, data.note)))
        self.repo.save(order)
        return order

    async def get(self, order_id: int) -> Order:
        order = self.repo.find(order_id)
        if order is None:
            raise HTTPException(status_code=404, detail="Order not found")
        return order
