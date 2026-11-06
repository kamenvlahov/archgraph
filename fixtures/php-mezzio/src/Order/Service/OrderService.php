<?php

declare(strict_types=1);

namespace App\Order\Service;

use App\Order\Dto\PlaceOrderDto;
use App\Order\Entity\Order;
use App\Order\Entity\OrderItem;
use App\Order\Repository\OrderRepositoryInterface;

final class OrderService implements OrderServiceInterface
{
    public function __construct(
        private readonly OrderRepositoryInterface $orders,
        private readonly PriceCalculator $prices,
    ) {
    }

    public function place(PlaceOrderDto $dto): Order
    {
        $order = new Order($dto->customerId);
        foreach ($dto->items as $item) {
            $order->addItem(new OrderItem($item['sku'], $item['quantity'], $this->prices->applyDiscount($item['price'], $dto->note)));
        }
        $this->orders->save($order);

        return $order;
    }

    public function get(int $id): ?Order
    {
        return $this->orders->find($id);
    }
}
