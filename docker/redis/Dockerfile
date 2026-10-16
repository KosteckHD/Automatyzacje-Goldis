FROM redis:7-alpine
RUN apk add --no-cache su-exec
COPY docker/redis/start-with-acl.sh /usr/local/bin/start-with-acl.sh
RUN chmod 0755 /usr/local/bin/start-with-acl.sh
ENTRYPOINT ["/usr/local/bin/start-with-acl.sh"]
