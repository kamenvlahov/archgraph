from typing import Protocol

from app.orders.models import Order


class OrderRepository(Protocol):
    def find(self, order_id: int) -> Order | None: ...

    def save(self, order: Order) -> None: ...


class InMemoryOrderRepository(OrderRepository):
    def __init__(self) -> None:
        self._orders: dict[int, Order] = {}

    def find(self, order_id: int) -> Order | None:
        return self._orders.get(order_id)

    def save(self, order: Order) -> None:
        if order.id is None:
            order.id = len(self._orders) + 1
        self._orders[order.id] = order
