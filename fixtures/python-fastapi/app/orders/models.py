from dataclasses import dataclass, field


@dataclass(kw_only=True)
class BaseEntity:
    id: int | None = None

    def get_id(self) -> int | None:
        return self.id


@dataclass(kw_only=True)
class OrderItem(BaseEntity):
    sku: str
    quantity: int
    price: float

    def subtotal(self) -> float:
        return self.quantity * self.price


@dataclass(kw_only=True)
class Order(BaseEntity):
    customer_id: int
    status: str = "new"
    items: list[OrderItem] = field(default_factory=list)

    def add_item(self, item: OrderItem) -> None:
        self.items.append(item)

    def total(self) -> float:
        return sum(item.subtotal() for item in self.items)
