<?php

declare(strict_types=1);

namespace App\Order\Repository;

use App\Order\Entity\Order;

interface OrderRepositoryInterface
{
    public function find(int $id): ?Order;

    public function save(Order $order): void;
}
