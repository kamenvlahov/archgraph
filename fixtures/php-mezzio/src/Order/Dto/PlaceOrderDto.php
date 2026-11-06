<?php

declare(strict_types=1);

namespace App\Order\Dto;

final readonly class PlaceOrderDto
{
    /**
     * @param list<array{sku: string, quantity: int, price: float}> $items
     */
    public function __construct(
        public int $customerId,
        public array $items,
        public ?string $note = null,
    ) {
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self((int) $data['customerId'], $data['items'], $data['note'] ?? null);
    }
}
