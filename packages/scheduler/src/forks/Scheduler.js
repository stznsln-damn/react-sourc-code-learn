/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable no-var */

import type {PriorityLevel} from '../SchedulerPriorities';

import {
  enableProfiling,
  frameYieldMs,
  userBlockingPriorityTimeout,
  lowPriorityTimeout,
  normalPriorityTimeout,
  enableRequestPaint,
  enableAlwaysYieldScheduler,
} from '../SchedulerFeatureFlags';

import {push, pop, peek} from '../SchedulerMinHeap';

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from '../SchedulerPriorities';
import {
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from '../SchedulerProfiling';

export type Callback = boolean => ?Callback;

// !单个任务类型
export opaque type Task = {
  id: number, // 任务id
  callback: Callback | null, // 回调
  priorityLevel: PriorityLevel, // 优先级
  startTime: number, // 开始时间
  expirationTime: number, // 过期时间
  sortIndex: number, // 排序依据
  isQueued?: boolean, // 是否已入队
};

// !获取当前时间 使用performance.now api 获取更精确的时间
let getCurrentTime: () => number | DOMHighResTimeStamp;
const hasPerformanceNow =
  // $FlowFixMe[method-unbinding]
  typeof performance === 'object' && typeof performance.now === 'function';

if (hasPerformanceNow) {
  const localPerformance = performance;
  getCurrentTime = () => localPerformance.now();
} else {
  const localDate = Date;
  const initialTime = localDate.now();
  getCurrentTime = () => localDate.now() - initialTime;
}

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Tasks are stored on a min heap
var taskQueue: Array<Task> = []; // !任务队列
var timerQueue: Array<Task> = []; // !延时任务队列

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1; // !id生成器

var currentTask = null; // !当前任务
var currentPriorityLevel = NormalPriority; // !当前优先级

// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false; // !锁 是否正在执行任务

var isHostCallbackScheduled = false; // !是否已调度 (任务调度)
var isHostTimeoutScheduled = false; // !是否已调度 (延时调度)

var needsPaint = false;

// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom

/**
 * !从延时任务队列中取出到期的任务，推入到任务队列
 * 检查是否有任务已经过期
 * 将过期的任务从延时队列转移到任务队列
 */
function advanceTimers(currentTime: number) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}

/**
 * !处理超时的延时任务
 */
function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false;
  advanceTimers(currentTime);

  // !检查是否有任务需要执行
  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

// !执行任务
function flushWork(initialTime: number) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        // !开始执行
        return workLoop(initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskErrored(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}

/**
 * !工作循环
 * @param {number} initialTime 初始时间
 * @returns {boolean} 是否还有未执行的任务
 */
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  // !检查任务过期
  advanceTimers(currentTime);
  // !取出堆顶任务
  currentTask = peek(taskQueue);
  while (currentTask !== null) {
    if (!enableAlwaysYieldScheduler) {
      // !任务还未过期 且 一个时间切片时间截止 退出任务循环 让出主线程
      if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
        // This currentTask hasn't expired, and we've reached the deadline.
        break;
      }
    }
    // $FlowFixMe[incompatible-use] found when upgrading Flow
    // !任务回调
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      currentTask.callback = null;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      currentPriorityLevel = currentTask.priorityLevel;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      // !判断任务是否过了超期时间
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        // $FlowFixMe[incompatible-call] found when upgrading Flow
        markTaskRun(currentTask, currentTime);
      }
      // !执行任务
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      // !如果任务回调又返回了一个函数 将返回的函数作为callback 跳过当前任务 下一次继续执行
      if (typeof continuationCallback === 'function') {
        // If a continuation is returned, immediately yield to the main thread
        // regardless of how much time is left in the current time slice.
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        currentTask.callback = continuationCallback;
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskYield(currentTask, currentTime);
        }
        // !检查延时到期任务
        advanceTimers(currentTime);
        return true;
      } else {
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskCompleted(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        // !任务执行完 出堆
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);
        }
        advanceTimers(currentTime);
      }
    } else {
      // !任务的callback不是函数 不执行并出堆 (调度支持取消)
      pop(taskQueue);
    }
    // !取出堆顶任务 继续执行
    currentTask = peek(taskQueue);
    if (enableAlwaysYieldScheduler) {
      if (currentTask === null || currentTask.expirationTime > currentTime) {
        // This currentTask hasn't expired we yield to the browser task.
        break;
      }
    }
  }
  // Return whether there's additional work
  // !还有未执行的任务
  if (currentTask !== null) {
    return true;
  } else {
    // !
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;
  }
}

function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T,
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  // $FlowFixMe[incompatible-return]
  // $FlowFixMe[missing-this-annot]
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

/**
 * !调度任务入口 往任务队列里加入任务 并开始执行
 * @param {PriorityLevel} priorityLevel 优先级
 * @param {Callback} callback 任务回调
 * @param {Object} options delay: 是否延迟执行 延迟执行放入延迟队列
 * @returns {Task}
 */
function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: {delay: number},
): Task {
  // !当前时间
  var currentTime = getCurrentTime();

  // !计算开始时间
  var startTime;
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    // !传了延迟时间 开始时间=当前时间+延迟时间
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;
    } else {
      // !没有传延迟时间 开始时间=当前时间
      startTime = currentTime;
    }
  } else {
    // !没有传延迟时间 开始时间=当前时间
    startTime = currentTime;
  }

  /* 计算任务过期(超期)时间 将根据超时时间对任务进行排序 */

  // !需要加的时间
  var timeout;
  switch (priorityLevel) {
    // !立即执行
    case ImmediatePriority:
      // Times out immediately
      timeout = -1;
      break;
    // !用户阻塞
    case UserBlockingPriority:
      // Eventually times out
      timeout = userBlockingPriorityTimeout;
      break;
    // !空闲
    case IdlePriority:
      // Never times out
      timeout = maxSigned31BitInt;
      break;
    // !低优先级
    case LowPriority:
      // Eventually times out
      timeout = lowPriorityTimeout;
      break;
    // !正常优先级
    case NormalPriority:
    default:
      // Eventually times out
      timeout = normalPriorityTimeout;
      break;
  }

  // !过期时间 = 开始时间 + 优先级时间
  var expirationTime = startTime + timeout;

  // !创建任务
  var newTask: Task = {
    id: taskIdCounter++,
    callback,
    priorityLevel,
    startTime, // !开始时间
    expirationTime, // !过期时间
    sortIndex: -1,
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }

  if (startTime > currentTime) {
    // !延迟任务
    // This is a delayed task.
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        // Cancel an existing timeout.
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // Schedule a timeout.
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    // !正常任务

    // !使用过期时间 当作排序依据
    newTask.sortIndex = expirationTime;
    // !加入队列 (最小堆)
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // !调度任务
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}

function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}

function unstable_getCurrentPriorityLevel(): PriorityLevel {
  return currentPriorityLevel;
}

let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);

// Scheduler periodically yields in case there is other work on the main
// thread, like user events. By default, it yields multiple times per frame.
// It does not attempt to align with frame boundaries, since most tasks don't
// need to be frame aligned; for those that do, use requestAnimationFrame.
let frameInterval = frameYieldMs;
let startTime = -1;

// !判断是否应该让出主线程 依据：当前时间-开始时间 > 一个时间切片的时间(5ms)
function shouldYieldToHost(): boolean {
  if (!enableAlwaysYieldScheduler && enableRequestPaint && needsPaint) {
    // Yield now.
    return true;
  }
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet.
    return false;
  }
  // Yield now.
  return true;
}

function requestPaint() {
  if (enableRequestPaint) {
    needsPaint = true;
  }
}

function forceFrameRate(fps: number) {
  if (fps < 0 || fps > 125) {
    // Using console['error'] to evade Babel and ESLint
    console['error'](
      'forceFrameRate takes a positive int between 0 and 125, ' +
        'forcing frame rates higher than 125 fps is not supported',
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    // reset the framerate
    frameInterval = frameYieldMs;
  }
}

/**
 * !时间切片
 * !开始执行任务 截止到一个时间切片
 */
const performWorkUntilDeadline = () => {
  if (enableRequestPaint) {
    needsPaint = false;
  }
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    // Keep track of the start time so we can measure how long the main thread
    // has been blocked.
    startTime = currentTime;

    // If a scheduler task throws, exit the current browser task so the
    // error can be observed.
    //
    // Intentionally not using a try-catch, since that makes some debugging
    // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
    // remain true, and we'll continue the work loop.
    let hasMoreWork = true;
    try {
      // !执行任务 传入开始执行的时间
      hasMoreWork = flushWork(currentTime);
    } finally {
      // !如果还有未执行的任务 下一个时间切片执行剩余的任务
      if (hasMoreWork) {
        // If there's more work, schedule the next message event at the end
        // of the preceding one.
        schedulePerformWorkUntilDeadline();
      } else {
        isMessageLoopRunning = false;
      }
    }
  }
};

/**
 * !使用MessageChannel 把下一个时间切片放入宏任务中 达到让出主线程的目的
 */
let schedulePerformWorkUntilDeadline;
if (typeof localSetImmediate === 'function') {
  // !Node环境
  // Node.js and old IE.
  // There's a few reasons for why we prefer setImmediate.
  //
  // Unlike MessageChannel, it doesn't prevent a Node.js process from exiting.
  // (Even though this is a DOM fork of the Scheduler, you could get here
  // with a mix of Node.js 15+, which has a MessageChannel, and jsdom.)
  // https://github.com/facebook/react/issues/20756
  //
  // But also, it runs earlier which is the semantic we want.
  // If other browsers ever implement it, it's better to use it.
  // Although both of these would be inferior to native scheduling.
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
} else if (typeof MessageChannel !== 'undefined') {
  // !浏览器环境 使用MessageChannel
  // DOM and Worker environments.
  // We prefer MessageChannel because of the 4ms setTimeout clamping.
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
} else {
  // !适配低版本浏览器 使用setTimeout 需要注意setTimeout有最小4ms的延迟
  // We should only fallback here in non-browser environments.
  schedulePerformWorkUntilDeadline = () => {
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}

// !开始调度
function requestHostCallback() {
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    schedulePerformWorkUntilDeadline();
  }
}

function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number,
) {
  // $FlowFixMe[not-a-function] nullable value
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  // $FlowFixMe[not-a-function] nullable value
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  requestPaint as unstable_requestPaint,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling: {
  startLoggingProfilingEvents(): void,
  stopLoggingProfilingEvents(): ArrayBuffer | null,
} | null = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
    }
  : null;
