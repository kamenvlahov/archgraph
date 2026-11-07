<?php

declare(strict_types=1);

namespace App\Order\Handler;

use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

// Стар стил: контейнерът е без тип и услугата се взима по низ. Графът не знае получателя.
final class ReorderHandler implements RequestHandlerInterface
{
    public function __construct(private $container)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $order = $this->container->get('orders')->place($request->getAttribute('dto'));

        return new JsonResponse(['id' => $order->getId()], 201);
    }
}
