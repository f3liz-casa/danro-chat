import { nanoid } from "nanoid";

export type VisitorId = string;

export function newVisitorId(): VisitorId {
  return nanoid();
}
