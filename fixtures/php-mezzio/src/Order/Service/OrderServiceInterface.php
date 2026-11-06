<?php

declare(strict_types=1);

namespace App\Order\Service;

use App\Order\Dto\PlaceOrderDto;
use App\Order\Entity\Order;

interface OrderServiceInterface
{
    public function place(PlaceOrderDto $dto): Order;

    public function get(int $id): ?Order;
}
