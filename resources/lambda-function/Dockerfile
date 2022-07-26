FROM amazon/aws-lambda-nodejs:14
WORKDIR ${LAMBDA_TASK_ROOT}

COPY package.json ./
RUN npm install --only=production
COPY index.js ./
COPY secret-utils.js ./

CMD [ "index.handler" ]