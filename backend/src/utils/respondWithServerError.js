const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

function respondWithServerError(res, error, operation, body = { error: 'An internal server error occurred.' }) {
    const diagnostic = { name: SAFE_CODE.test(error?.name || '') ? error.name : 'Error' };
    if (typeof error?.code === 'string' && SAFE_CODE.test(error.code)) diagnostic.code = error.code;
    if (typeof error?.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(error.sqlState)) diagnostic.sqlState = error.sqlState;
    console.error(`[api] ${operation} failed`, diagnostic);
    return res.status(500).json(body);
}

module.exports = { respondWithServerError };
