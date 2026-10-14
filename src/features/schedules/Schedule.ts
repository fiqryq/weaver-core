import { Schema } from "effect"

/** Shortest interval a schedule may repeat at, so a bot can't keep itself busy around the clock. */
export const minEveryMinutes = 15
/** Longest interval: 30 days. */
export const maxEveryMinutes = 30 * 24 * 60
/** Most schedules one conversation can have. */
export const maxPerConversation = 10

/**
 * A task repeated in a conversation: when it's due, `prompt` is posted there as the person's message
 * and the conversation's bots reply, as if the person had sent it.
 */
export class Schedule extends Schema.Class<Schedule>("Schedule")({
  id: Schema.String,
  conversationId: Schema.String,
  /** The bot that set it up. */
  botId: Schema.String,
  /** Short label, e.g. "Remote job scrape". */
  title: Schema.String,
  prompt: Schema.String,
  everyMinutes: Schema.Int,
  nextRunAt: Schema.String,
  lastRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String
}) {}

export class ScheduleNotFound extends Schema.TaggedError<ScheduleNotFound>()("ScheduleNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

/** The text posted when a schedule runs; the bot sees it as the person's message. */
export const scheduledMessage = (schedule: Pick<Schedule, "title" | "prompt">): string =>
  `⏰ Scheduled task "${schedule.title}":\n${schedule.prompt}`

/** e.g. "every 5 hours", "every 90 minutes", "every day". */
export const describeEvery = (minutes: number): string => {
  const unit = (n: number, name: string) => (n === 1 ? `every ${name}` : `every ${n} ${name}s`)
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day")
  if (minutes % 60 === 0) return unit(minutes / 60, "hour")
  return unit(minutes, "minute")
}
