<?php

declare(strict_types=1);

namespace App\Order\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'orders')]
class Order extends AbstractEntity
{
    /** @var list<OrderItem> */
    private array $items = [];

    public function __construct(
        #[ORM\Column]
        private readonly int $customerId,
        #[ORM\Column]
        private string $status = 'new',
    ) {
    }

    public function addItem(OrderItem $item): void
    {
        $this->items[] = $item;
    }

    /** @return list<OrderItem> */
    public function getItems(): array
    {
        return $this->items;
    }

    public function total(): float
    {
        return array_sum(array_map(static fn (OrderItem $i): float => $i->subtotal(), $this->items));
    }
}
