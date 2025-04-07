/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export const enableProfiling = false;
export const frameYieldMs = 5; // !一个时间切片的时间 5ms

export const userBlockingPriorityTimeout = 250; // !用户阻塞优先级超时时间
export const normalPriorityTimeout = 5000; // !正常优先级超时时间
export const lowPriorityTimeout = 10000; // !低优先级超时时间
export const enableRequestPaint = true;

export const enableAlwaysYieldScheduler = __EXPERIMENTAL__;
