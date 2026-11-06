import { Column, Entity, OneToMany } from 'typeorm';
import { AbstractEntity } from './abstract.entity';
import { OrderItem } from './order-item.entity';

@Entity('orders')
export class Order extends AbstractEntity {
  @Column()
  customerId!: number;

  @Column({ default: 'new' })
  status: string = 'new';

  @OneToMany(() => OrderItem, (item) => item.id, { cascade: true })
  items: OrderItem[] = [];

  static create(customerId: number): Order {
    const order = new Order();
    order.customerId = customerId;
    return order;
  }

  addItem(item: OrderItem): void {
    this.items.push(item);
  }

  total(): number {
    return this.items.reduce((sum, item) => sum + item.subtotal(), 0);
  }
}
