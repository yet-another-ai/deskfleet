use super::*;

#[actix_web::test]
#[ignore = "requires real PostgreSQL TEST_DATABASE_URL"]
async fn anonymous_options_hide_accounts_and_assertions_keep_their_bindings() {
    let state = web::Data::new(
        AppState::new(ServerConfig {
            bind_addrs: vec!["127.0.0.1:0".parse().unwrap()],
            database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
            public_url: "http://localhost".into(),
            web_origins: vec!["http://localhost".into()],
            auth: AuthConfig::development("http://localhost"),
            billing: Default::default(),
            stun_urls: vec![],
            turn_urls: vec![],
            turn_secret: None,
            turn_usage_redis_url: None,
        })
        .await
        .unwrap(),
    );
    let app = test::init_service(App::new().app_data(state.clone()).configure(configure)).await;
    let csrf = "passkey-privacy-test-csrf-token-32";
    let prefix = uuid::Uuid::new_v4();
    let mut accounts = Vec::new();
    for label in ["one-key", "two-keys", "no-key", "unverified", "disabled"] {
        let email = format!("{label}-{prefix}@example.test");
        let user = state.store.verified_user(&email, label).await.unwrap();
        accounts.push(user);
    }
    for (index, column) in [(3, "email_verified"), (4, "disabled")] {
        state
            .store
            .database()
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("UPDATE cp_users SET {column}=$1 WHERE id=$2"),
                vec![(index == 4).into(), accounts[index].id.clone().into()],
            ))
            .await
            .unwrap();
    }
    let session = state.store.new_session(&accounts[0].id).await.unwrap();
    let token = session["token"].as_str().unwrap();
    let mut authenticator = resident_passkey::ResidentPasskey::new();
    for (index, count) in [(0, 1), (1, 2)] {
        let session = state.store.new_session(&accounts[index].id).await.unwrap();
        let token = session["token"].as_str().unwrap();
        for _ in 0..count {
            let options: Value = test::call_and_read_body_json(
                &app,
                request(
                    Method::POST,
                    "/api/auth/passkeys/register/options",
                    csrf,
                    Some(token),
                )
                .to_request(),
            )
            .await;
            let credential = authenticator
                .do_registration(
                    url::Url::parse("http://localhost").unwrap(),
                    serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
                )
                .unwrap();
            let response = test::call_service(
                &app,
                request(Method::POST, "/api/auth/passkeys/register", csrf, Some(token))
                    .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential,"name":"Resident test key"}))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
        }
    }

    // Compare the whole public response, including repeated requests and
    // different key counts. Only fresh challenge/token values may differ.
    let unknown = format!("missing-{prefix}@example.test");
    let emails: Vec<_> = accounts
        .iter()
        .map(|account| account.email.as_deref().unwrap())
        .chain(std::iter::once(unknown.as_str()))
        .collect();
    let mut expected = None;
    let mut previous_challenges = std::collections::HashSet::new();
    let mut previous_ceremonies = std::collections::HashSet::new();
    for email in &emails {
        for _ in 0..2 {
            let response = test::call_service(
                &app,
                request(Method::POST, "/api/auth/passkeys/login/options", csrf, None)
                    .set_json(json!({"email":email}))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK, "{email}");
            let mut options: Value = test::read_body_json(response).await;
            assert!(previous_ceremonies.insert(options["ceremonyId"].as_str().unwrap().to_owned()));
            assert!(
                previous_challenges.insert(
                    options["publicKey"]["challenge"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                )
            );
            assert_eq!(options["publicKey"]["allowCredentials"], json!([]));
            options.as_object_mut().unwrap().remove("ceremonyId");
            options["publicKey"]
                .as_object_mut()
                .unwrap()
                .remove("challenge");
            if let Some(expected) = &expected {
                assert_eq!(&options, expected, "{email}");
            } else {
                expected = Some(options);
            }
        }
    }

    // A real signature from account A cannot authenticate account B, a missing
    // mailbox, an unverified/disabled account, or a verified account with no key.
    for email in &emails[1..] {
        let options: Value = test::call_and_read_body_json(
            &app,
            request(Method::POST, "/api/auth/passkeys/login/options", csrf, None)
                .set_json(json!({"email":email}))
                .to_request(),
        )
        .await;
        let credential = authenticator
            .do_authentication(
                url::Url::parse("http://localhost").unwrap(),
                serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
            )
            .unwrap();
        let response = test::call_service(
            &app,
            request(Method::POST, "/api/auth/passkeys/login", csrf, None)
                .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{email}");
    }

    // Authenticated reauthentication retains its credential allow list and
    // accepts nonresident assertions without a userHandle, but remains bound
    // to the session and purpose that requested the challenge.
    let other_session = state.store.new_session(&accounts[0].id).await.unwrap();
    for wrong_session in [true, false] {
        let options: Value = test::call_and_read_body_json(
            &app,
            request(
                Method::POST,
                "/api/auth/passkeys/reauthenticate/options",
                csrf,
                Some(token),
            )
            .to_request(),
        )
        .await;
        assert_eq!(
            options["publicKey"]["allowCredentials"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut credential = authenticator
            .do_authentication(
                url::Url::parse("http://localhost").unwrap(),
                serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
            )
            .unwrap();
        credential.response.user_handle = None;
        let body = json!({"ceremonyId":options["ceremonyId"],"credential":credential});
        let response = test::call_service(
            &app,
            request(Method::POST, "/api/auth/passkeys/login", csrf, None)
                .set_json(&body)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let target = if wrong_session {
            other_session["token"].as_str().unwrap()
        } else {
            token
        };
        let response = test::call_service(
            &app,
            request(
                Method::POST,
                "/api/auth/passkeys/reauthenticate",
                csrf,
                Some(target),
            )
            .set_json(&body)
            .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            if wrong_session {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::NO_CONTENT
            }
        );
        let replay = test::call_service(
            &app,
            request(
                Method::POST,
                "/api/auth/passkeys/reauthenticate",
                csrf,
                Some(token),
            )
            .set_json(&body)
            .to_request(),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }

    // The account version is captured when options are issued. Retain this
    // challenge while advancing the version to exercise the final version
    // check independently of revocation's eager challenge deletion.
    let options: Value = test::call_and_read_body_json(
        &app,
        request(Method::POST, "/api/auth/passkeys/login/options", csrf, None)
            .set_json(json!({"email":emails[0]}))
            .to_request(),
    )
    .await;
    let credential = authenticator
        .do_authentication(
            url::Url::parse("http://localhost").unwrap(),
            serde_json::from_value(json!({"publicKey":options["publicKey"]})).unwrap(),
        )
        .unwrap();
    state
        .store
        .database()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE cp_users SET credential_version=credential_version+1 WHERE id=$1",
            vec![accounts[0].id.clone().into()],
        ))
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        request(Method::POST, "/api/auth/passkeys/login", csrf, None)
            .set_json(json!({"ceremonyId":options["ceremonyId"],"credential":credential}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
