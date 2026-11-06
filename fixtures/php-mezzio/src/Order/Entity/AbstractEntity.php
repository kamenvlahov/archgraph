<?php

declare(strict_types=1);

namespace App\Order\Entity;

abstract class AbstractEntity
{
    protected ?int $id = null;

    public function getId(): ?int
    {
        return $this->id;
    }
}
