import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { ORDER_REPOSITORY } from './order.repository';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PriceCalculator } from './price-calculator.js';
import { TypeOrmOrderRepository } from './typeorm-order.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem])],
  controllers: [OrdersController],
  providers: [OrdersService, PriceCalculator, { provide: ORDER_REPOSITORY, useClass: TypeOrmOrderRepository }],
})
export class OrdersModule {}
