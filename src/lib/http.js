/** Envuelve un handler async para que sus rechazos lleguen al manejador de errores. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
