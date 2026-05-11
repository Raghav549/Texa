import {
  Request,
  Response,
  NextFunction
} from 'express';

export const adminOnly = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const role =
      (req as any).role;

    if (
      role !== 'ADMIN' &&
      role !== 'SUPERADMIN'
    ) {

      return res.status(403).json({
        error:
          'Admin access required'
      });
    }

    next();

  } catch (error) {

    console.error(
      'Admin middleware error:',
      error
    );

    return res.status(500).json({
      error:
        'Internal server error'
    });
  }
};
