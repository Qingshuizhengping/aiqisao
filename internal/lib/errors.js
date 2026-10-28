export class AppError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
    }
}

export function fail(status, code, message) {
    throw new AppError(status, code, message);
}

export function asyncRoute(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
