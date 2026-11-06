<?php

declare(strict_types=1);

namespace App\Order\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class OrderItem extends AbstractEntity
{
    public function __construct(
        #[ORM\Column]
        public readonly string $sku,
        #[ORM\Column]
        public readonly int $quantity,
        #[ORM\Column]
        public readonly float $price,
    ) {
    }

    public function subtotal(): float
    {
        return $this->quantity * $this->price;
    }
}
