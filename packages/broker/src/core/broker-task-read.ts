import { taskMatchesFilters, applyTaskListLimit } from "./broker-list-filters.js";
import { sortedCopy, sortNewestFirst } from "./broker-helpers.js";
import { normalizeTaskRecord } from "./broker-task-record-normalizers.js";
import { summarizeRoundStatus, type RoundStatusSummary } from "./round-status.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TaskListFilters, TaskRecord } from "./types.js";

/**
 * Read one task, preferring the live in-memory mutation map.
 *
 * This is `requireTask`, so it runs on the front of essentially every task
 * route. It used to query the repository first, which on the SQLite backend
 * meant a prepared SELECT plus a full zod parse of the task payload on every
 * lookup, even though the broker had just written that record itself.
 *
 * The map is authoritative for live state: every write path goes through
 * `setTaskRecord`, which stores the same (already normalized) record in the map
 * and the repository, and snapshot restore normalizes on the way in. The
 * repository lookup stays as the fallback for records the map does not hold —
 * rows persisted by an earlier process, or tasks dropped from memory by
 * retention — and still normalizes and back-fills the map so the next read is
 * a map hit.
 */
export function readBrokerTask(
  tasks: Map<string, TaskRecord>,
  taskRepository: TaskRuntimeRepository | undefined,
  id: string,
): TaskRecord | null {
  const cached = tasks.get(id);
  if (cached) {
    return cached;
  }
  const repositoryTask = taskRepository?.getTask(id);
  if (repositoryTask) {
    const task = normalizeTaskRecord(repositoryTask);
    tasks.set(task.id, task);
    return task;
  }
  return null;
}

export function listBrokerTasks(
  tasks: Map<string, TaskRecord>,
  taskRepository: TaskRuntimeRepository | undefined,
  filters?: TaskListFilters,
): TaskRecord[] {
  const tasksById = new Map(tasks);
  if (taskRepository) {
    for (const repositoryTask of taskRepository.listTasks(filters).map(normalizeTaskRecord)) {
      tasks.set(repositoryTask.id, repositoryTask);
      tasksById.set(repositoryTask.id, repositoryTask);
    }
  }
  const sortedTasks = sortedCopy(
    [...tasksById.values()].filter((task) => taskMatchesFilters(task, filters)),
    sortNewestFirst,
  );
  return applyTaskListLimit(sortedTasks, filters?.limit);
}

/**
 * `GET /rounds/:id/status`. The round id is pushed into the task list filter so
 * the repository can answer it with an indexed lookup; before this it listed
 * every task in the store — a full table scan plus a zod parse per row — and
 * discarded all but the handful belonging to the round.
 */
export function getBrokerRoundStatus(
  tasks: Map<string, TaskRecord>,
  taskRepository: TaskRuntimeRepository | undefined,
  parentRoundId: string,
): RoundStatusSummary {
  return summarizeRoundStatus(listBrokerTasks(tasks, taskRepository, { parentRoundId }), parentRoundId);
}
