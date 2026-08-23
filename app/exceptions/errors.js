// eslint-disable-next-line max-classes-per-file
class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRequestError';
    this.message = message;
    this.statusCode = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.message = message;
    this.statusCode = 404;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.message = message;
    this.statusCode = 409;
  }
}

class UnauthorizedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnauthorizedError';
    this.message = message;
    this.statusCode = 401;
  }
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenError';
    this.message = message;
    this.statusCode = 403;
  }
}

class ServerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerError';
    this.message = message;
    this.statusCode = 500;
  }
}

const handleError = (error, res) => {
  if (error.statusCode) {
    const { statusCode, message } = error;
    return res.status(statusCode).send({ message });
  }
  // A mongoose schema validation failure is the caller sending something the model
  // rejects, which is the same class of problem the route validators return 422 for.
  // Without this it surfaces as a 500, reading as a server fault rather than bad input.
  if (error.name === 'ValidationError' && error.errors) {
    const message = Object.values(error.errors)
      .map((fieldError) => fieldError.message)
      .join(', ');
    return res.status(422).send({ message: message || error.message });
  }
  const message = error.message || 'Server Error';
  return res.status(500).send({ message });
};

module.exports = {
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ServerError,
  handleError,
};
