/**
 * React error boundary catching unhandled exceptions in the component tree.
 * Displays a user-friendly fallback UI with retry option and logs errors.
 * @inputs children ReactNode to wrap, optional onError callback
 * @exports Default ErrorBoundary class component
 */
import { Component, ReactNode } from 'react';
import { logger } from '../utils/logger';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.ui.error('React component error caught by ErrorBoundary', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    });
    this.setState({ errorInfo });
  }

  handleReset = (): void => {
    logger.ui.info('ErrorBoundary reset requested');
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center bg-black text-white p-6 text-center">
          <div className="max-w-md">
            <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
            <p className="text-gray-400 mb-6">
              An unexpected error occurred. Please reload the app to continue.
            </p>
            {this.state.error && (
              <details className="mb-6 text-left bg-gray-900 p-4 rounded-lg text-sm">
                <summary className="cursor-pointer text-gray-300 mb-2">
                  Technical Details
                </summary>
                <pre className="text-red-400 whitespace-pre-wrap break-words overflow-auto max-h-40">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={this.handleReset}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
