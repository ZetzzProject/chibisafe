import path from 'node:path';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyReply } from 'fastify';
import jetpack from 'fs-jetpack';
import { z } from 'zod';
import prisma from '@/structures/database.js';
import type { RequestWithUser } from '@/structures/interfaces.js';
import { http4xxErrorSchema } from '@/structures/schemas/HTTP4xxError.js';
import { http5xxErrorSchema } from '@/structures/schemas/HTTP5xxError.js';
import { SETTINGS } from '@/structures/settings.js';
import { quarantinePath, uploadPath } from '@/utils/File.js';
import { generateThumbnails } from '@/utils/Thumbnails.js';

export const schema = {
	summary: 'Unquarantine file',
	description: 'Removes the quarantine status from a file',
	tags: ['Files'],
	params: z
		.object({
			uuid: z.string().describe('The uuid of the file.')
		})
		.required(),
	response: {
		200: z.object({
			message: z.string().describe('The response message.')
		}),
		'4xx': http4xxErrorSchema,
		'5xx': http5xxErrorSchema
	}
};

export const options = {
	url: '/admin/file/:uuid/allow',
	method: 'post',
	middlewares: ['apiKey', 'auth', 'admin']
};

export const run = async (req: RequestWithUser, res: FastifyReply) => {
	const { uuid } = req.params as {
		uuid: string;
	};

	const file = await prisma.files.findFirst({
		where: {
			uuid,
			quarantine: true
		},
		select: {
			uuid: true,
			name: true,
			isS3: true,
			isHF: true,
			isWatched: true,
			quarantineFile: true
		}
	});

	if (!file) {
		void res.notFound("The file doesn't exist");
		return;
	}

	if (file.isWatched) {
		void res.badRequest('You cannot allow a watched file');
		return;
	}

	if (file.isS3) {
		const { createS3Client } = await import('@/structures/s3.js');
		const S3Client = createS3Client();

		const copyCommand = new CopyObjectCommand({
			Bucket: SETTINGS.S3Bucket,
			Key: file.name,
			CopySource: `${SETTINGS.S3Bucket}/quarantine/${file.quarantineFile!.name}`
		});
		const removeCommand = new DeleteObjectCommand({
			Bucket: SETTINGS.S3Bucket,
			Key: `quarantine/${file.quarantineFile!.name}`
		});

		await S3Client.send(copyCommand);
		await S3Client.send(removeCommand);
	} else if (file.isHF) {
		const quarantineKey = `quarantine/${file.quarantineFile!.name}`;
		
		const pathsInfoUrl = `https://huggingface.co/api/buckets/${SETTINGS.HFBucket}/paths-info`;
		const pathsInfoRes = await fetch(pathsInfoUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${SETTINGS.HFToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ paths: [quarantineKey] })
		});

		if (!pathsInfoRes.ok) {
			req.log.error(`Failed to fetch HF path info: ${await pathsInfoRes.text()}`);
			void res.internalServerError('Failed to fetch HF path info');
			return;
		}

		const pathsInfo = await pathsInfoRes.json();
		const xetHash = pathsInfo[0]?.xet_hash;

		if (!xetHash) {
			req.log.error('Could not find xet_hash for HF file');
			void res.internalServerError('Could not find xet_hash for HF file');
			return;
		}
		const hfBatchUrl = `https://huggingface.co/api/buckets/${SETTINGS.HFBucket}/batch`;
		const batchRes = await fetch(hfBatchUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${SETTINGS.HFToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				// Format: ["bucket", "source_bucket_id", "xet_hash", "destination_path"]
				copy: [
					["bucket", SETTINGS.HFBucket, xetHash, file.name]
				],
				delete: [quarantineKey]
			})
		});

		if (!batchRes.ok) {
			req.log.error(`Failed to allow HF file: ${await batchRes.text()}`);
			void res.internalServerError('Failed to allow HF file');
			return;
		}
	}

	await prisma.files.update({
		where: {
			uuid
		},
		data: {
			quarantine: false,
			quarantineFile: {
				delete: true
			}
		}
	});

	if (!file.isS3) {
		await jetpack.moveAsync(path.join(quarantinePath, file.quarantineFile!.name), path.join(uploadPath, file.name));
	}

	void generateThumbnails({
		filename: file.name,
		tmp: file.isS3,
		watched: file.isWatched
	});

	return res.send({
		message: 'Successfully allowed the file'
	});
};
