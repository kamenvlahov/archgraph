<?php

declare(strict_types=1);

namespace App\Order\Handler;

use App\Order\Service\OrderServiceInterface;
use Laminas\Diactoros\Response\EmptyResponse;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

final class GetOrderHandler implements RequestHandlerInterface
{
    public function __construct(private readonly OrderServiceInterface $orders)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $order = $this->orders->get((int) $request->getAttribute('id'));
        if ($order === null) {
            return new EmptyResponse(404);
        }

        return new JsonResponse(['id' => $order->getId(), 'items' => count($order->getItems())]);
    }
}
