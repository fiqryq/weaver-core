import { Schema } from "effect"

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String
}, { httpApiStatus: 400 }) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String
}, { httpApiStatus: 409 }) {}
