<?php

declare(strict_types=1);

namespace App\Order\Repository;

use Doctrine\ORM\EntityManagerInterface;
use Psr\Container\ContainerInterface;

final class DoctrineOrderRepositoryFactory
{
    public function __invoke(ContainerInterface $container): DoctrineOrderRepository
    {
        return new DoctrineOrderRepository($container->get(EntityManagerInterface::class));
    }
}
