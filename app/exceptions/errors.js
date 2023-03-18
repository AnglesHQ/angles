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
    res.status(statusCode).send({ message });
  }
  const message = error.message || 'Server Error';
  return res.status(500).send({ message });
};

module.exports = {
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  ServerError,
  handleError,
};
