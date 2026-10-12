import type { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/** Envelope of every list response (room for pagination later). */
export interface ListResponse<T> {
  items: T[];
}

/**
 * OpenAPI class of `{ items: T[] }` for one view class, named after it
 * (TenantView -> TenantList). Create it ONCE per view (views.ts).
 */
export function listOf<T>(item: Type<T>): Type<ListResponse<T>> {
  class List implements ListResponse<T> {
    @ApiProperty({ type: [item] })
    items!: T[];
  }

  Object.defineProperty(List, 'name', {
    value: `${item.name.replace(/View$/, '')}List`,
  });

  return List;
}
