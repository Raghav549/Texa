import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
const s3 = new S3Client({ region: process.env.AWS_REGION!, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY!, secretAccessKey: process.env.AWS_SECRET_KEY! } });

export const uploadFile = async (file: Express.Multer.File, folder: string): Promise<string> => {
  const key = `${folder}/${uuid()}_${file.originalname}`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET!, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL: 'public-read' }));
  return `https://${process.env.AWS_BUCKET!.s3.amazonaws.com}/${key}`;
};
