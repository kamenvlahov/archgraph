<?php

declare(strict_types=1);

use App\Order\Handler\GetOrderHandler;
use App\Order\Handler\PlaceOrderHandler;
use Mezzio\Application;

return static function (Application $app): void {
    $app->post('/orders', PlaceOrderHandler::class, 'orders.place');
    $app->get('/orders/{id:\d+}', GetOrderHandler::class, 'orders.get');
};
