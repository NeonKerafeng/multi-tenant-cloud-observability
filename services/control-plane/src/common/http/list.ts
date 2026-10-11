/** Envelope of every list response (room for pagination later). */
export interface ListResponse<T> {
  items: T[];
}
