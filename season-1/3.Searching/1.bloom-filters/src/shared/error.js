export const errorHandler = (err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  reply.code(status).send({ error: err.message });
};
