import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [TypeOrmModule.forRoot({ type: 'sqlite', database: 'orders.db', autoLoadEntities: true }), OrdersModule],
})
export class AppModule {}
