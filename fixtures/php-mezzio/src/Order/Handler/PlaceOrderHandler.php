<?php

declare(strict_types=1);

namespace App\Order\Handler;

use App\Order\Dto\PlaceOrderDto;
use App\Order\Service\OrderServiceInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

final class PlaceOrderHandler implements RequestHandlerInterface
{
    public function __construct(private readonly OrderServiceInterface $orders)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        /** @var array<string, mixed> $body */
        $body = $request->getParsedBody();
        $order = $this->orders->place(PlaceOrderDto::fromArray($body));

        return new JsonResponse(['id' => $order->getId(), 'total' => $order->total()], 201);
    }
}
