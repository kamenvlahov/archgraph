<?php

declare(strict_types=1);

namespace App;

use App\Order\Handler;
use App\Order\Repository;
use App\Order\Service;

final class ConfigProvider
{
    /** @return array<string, mixed> */
    public function __invoke(): array
    {
        return [
            'dependencies' => $this->getDependencies(),
        ];
    }

    /** @return array<string, array<string, string>> */
    public function getDependencies(): array
    {
        return [
            'aliases' => [
                Repository\OrderRepositoryInterface::class => Repository\DoctrineOrderRepository::class,
                Service\OrderServiceInterface::class => Service\OrderService::class,
            ],
            'factories' => [
                Repository\DoctrineOrderRepository::class => Repository\DoctrineOrderRepositoryFactory::class,
                Service\OrderService::class => Service\OrderServiceFactory::class,
                Handler\PlaceOrderHandler::class => Handler\PlaceOrderHandlerFactory::class,
                Handler\GetOrderHandler::class => Handler\GetOrderHandlerFactory::class,
            ],
        ];
    }
}
