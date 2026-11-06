<?php

declare(strict_types=1);

namespace App\Order\Handler;

use App\Order\Service\OrderServiceInterface;
use Psr\Container\ContainerInterface;

final class PlaceOrderHandlerFactory
{
    public function __invoke(ContainerInterface $container): PlaceOrderHandler
    {
        return new PlaceOrderHandler($container->get(OrderServiceInterface::class));
    }
}
