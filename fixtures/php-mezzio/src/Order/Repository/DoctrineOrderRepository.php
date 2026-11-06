<?php

declare(strict_types=1);

namespace App\Order\Repository;

use App\Order\Entity\Order;
use Doctrine\ORM\EntityManagerInterface;

final class DoctrineOrderRepository implements OrderRepositoryInterface
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    public function find(int $id): ?Order
    {
        return $this->em->find(Order::class, $id);
    }

    public function save(Order $order): void
    {
        $this->em->persist($order);
        $this->em->flush();
    }
}
