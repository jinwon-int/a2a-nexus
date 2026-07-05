import { taskMatchesFilters, applyTaskListLimit } from "./broker-list-filters.js";
import { sortedCopy, sortNewestFirst } from "./broker-helpers.js";
import { normalizeTaskRecord } from "./broker-task-record-normalizers.js";
import { summarizeRoundStatus, type RoundStatusSummary } from "./round-status.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TaskListFilters, TaskRecord } from "./types.js";

export function readBrokerTask(
  tasks: Map<string, TaskRecord>,
  taskRepository: TaskRuntimeRepository | undefined,
  id: string,
): TaskRecord | null {
  const repositoryTask = taskRepository?.getTask(id);
  if (repositoryTask) {
    const task = normalizeTaskRecord(repositoryTask);
    tasks.set(task.id, task);
    return task;
  }
  return tasks.get(id) ?? null;
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

export function getBrokerRoundStatus(
  tasks: Map<string, TaskRecord>,
  taskRepository: TaskRuntimeRepository | undefined,
  parentRoundId: string,
): RoundStatusSummary {
  return summarizeRoundStatus(listBrokerTasks(tasks, taskRepository), parentRoundId);
}
