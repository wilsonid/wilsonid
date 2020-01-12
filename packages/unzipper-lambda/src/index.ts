import * as AdmZip from 'adm-zip';
import { S3 } from 'aws-sdk';
import { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import * as https from 'https';
import { lookup as mimeTypeLookup } from 'mime-types';
import { parse as parseURL } from 'url';

const SOURCE_BUCKET_NAME = process.env.SOURCE_BUCKET_NAME as string;

const s3 = new S3();

const getZipFromS3 = async (sourceBucketName: string, key: string): Promise<AdmZip> => {
    console.log(`s3.getObject Bucket=${sourceBucketName} Key=${key}`)
    const { Body: body } = await s3.getObject({
        Bucket: sourceBucketName,
        Key: key,
    }).promise();
    return new AdmZip(body as Buffer);
}

const getMimeType= (entryName: string): string => (
    mimeTypeLookup(entryName) || 'application/octet'
);

const pushAllFilesToS3 = async (destinationBucket: string, zip: AdmZip) => {
    await Promise.all(
        zip.getEntries().map((entry) => {
            console.log(`s3.putObject Bucket=${destinationBucket} Key=${entry.entryName}`);
            return s3.putObject({
                Body: zip.readAsText(entry.entryName),
                Bucket: destinationBucket,
                ContentType: getMimeType(entry.entryName),
                Key: entry.entryName,
            }).promise()
        })
    );
    console.log('SUCCESS status on completing s3.putObject(s)');
}

const getSuccessResponse = (event: CloudFormationCustomResourceEvent) => ({
    Status: 'SUCCESS',
    PhysicalResourceId: event.ResourceProperties.Key,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
});

const getErrorResponse = (e: Error, event: CloudFormationCustomResourceEvent) => ({
    Status: 'FAILED',
    Reason: e.toString(),
    PhysicalResourceId: event.ResourceProperties.Key,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
});

const unzip = async (event: CloudFormationCustomResourceEvent) => {
    try {
        if (event.RequestType !== "Delete") {
            const zip = await getZipFromS3(SOURCE_BUCKET_NAME, event.ResourceProperties.Key);
            await pushAllFilesToS3(event.ResourceProperties.DestinationBucket, zip);
        }
        return getSuccessResponse(event);
    } catch(e) {
        console.log(`FAILED unzip operation on catching an error: ${e}`);
        return getErrorResponse(e, event);
    }
};

const sendResponse = async (response: any, urlString: string) => {
    console.log(`Sending response to ${urlString}`);
    const responseBody = JSON.stringify(response);
    const url = parseURL(urlString);
    const options = {
        headers: {
            'Content-Type': '',
            'Content-Length': responseBody.length,
        },
        hostname: url.hostname,
        method: 'PUT',
        port: url.port || 443,
        path: url.path,
        rejectUnauthorized: true,
    };

    return new Promise((resolve, reject) => {
        const request = https.request(options, (response) => {
            response.on('end', resolve);
        });
        request.on('error', reject);

        request.write(responseBody);
        request.end();
    });
}

export const handler = async (event: CloudFormationCustomResourceEvent, context: Context) => {
    console.log(`Called with assumed role ${context.identity}`);
    const result = await unzip(event);
    try {
        await sendResponse(result, event.ResponseURL);
    } catch (e) {
        console.error(`FAILED sending response to ${event.ResponseURL}`, result);
        throw e;
    }
};