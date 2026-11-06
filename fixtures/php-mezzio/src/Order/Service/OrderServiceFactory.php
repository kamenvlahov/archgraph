<?php

declare(strict_types=1);

namespace App\Order\Service;

use App\Order\Repository\OrderRepositoryInterface;
use Psr\Container\ContainerInterface;

final class OrderServiceFactory
{
    public function __invoke(ContainerInterface $container): OrderService
    {
        return new OrderService(
            $container->get(OrderRepositoryInterface::class),
            new PriceCalculator(),
        );
    }
}
