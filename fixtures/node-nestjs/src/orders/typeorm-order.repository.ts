import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import type { OrderRepository } from './order.repository';

@Injectable()
export class TypeOrmOrderRepository implements OrderRepository {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  find(id: number): Promise<Order | null> {
    return this.orders.findOne({ where: { id }, relations: { items: true } });
  }

  async save(order: Order): Promise<void> {
    await this.orders.save(order);
  }
}
