import { PrimaryGeneratedColumn } from 'typeorm';

export abstract class AbstractEntity {
  @PrimaryGeneratedColumn()
  id?: number;

  getId(): number | undefined {
    return this.id;
  }
}
