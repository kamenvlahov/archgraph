from functools import lru_cache

from fastapi import Depends

from app.orders.repository import InMemoryOrderRepository, OrderRepository
from app.orders.service import OrderService


@lru_cache
def get_repository() -> OrderRepository:
    return InMemoryOrderRepository()


def get_service(repo: OrderRepository = Depends(get_repository)) -> OrderService:
    return OrderService(repo)
