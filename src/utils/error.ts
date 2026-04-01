/**
 * Error Handling and Logging Utilities
 */

import { logger } from './logger'

export enum ErrorType {
  FILE_ERROR = "FILE_ERROR",
  API_ERROR = "API_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NETWORK_ERROR = "NETWORK_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export interface ErrorLog {
  id: string;
  timestamp: string;
  type: ErrorType;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

class ErrorHandler {
  private errorLogs: ErrorLog[] = [];
  private maxLogs: number = 100;

  logError(
    type: ErrorType,
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): ErrorLog {
    const errorLog: ErrorLog = {
      id: `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type,
      message,
      stack: error?.stack,
      context,
    };

    this.errorLogs.push(errorLog);
    if (this.errorLogs.length > this.maxLogs) {
      this.errorLogs = this.errorLogs.slice(-this.maxLogs);
    }

    logger.error(type, message, error || "");
    return errorLog;
  }

  handleFileError(message: string, error?: Error): ErrorLog {
    return this.logError(ErrorType.FILE_ERROR, message, error);
  }

  handleValidationError(message: string, context?: Record<string, unknown>): ErrorLog {
    return this.logError(ErrorType.VALIDATION_ERROR, message, undefined, context);
  }

  getRecentErrors(count: number = 10): ErrorLog[] {
    return this.errorLogs.slice(-count);
  }

  clearLogs(): void {
    this.errorLogs = [];
  }
}

export const errorHandler = new ErrorHandler();
