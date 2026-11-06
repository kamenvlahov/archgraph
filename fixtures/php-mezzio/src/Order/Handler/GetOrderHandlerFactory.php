<?php

declare(strict_types=1);

namespace App\Order\Handler;

use App\Order\Service\OrderServiceInterface;
use Psr\Container\ContainerInterface;

final class GetOrderHandlerFactory
{
    public function __invoke(ContainerInterface $container): GetOrderHandler
    {
        return new GetOrderHandler($container->get(OrderServiceInterface::class));
    }
}
